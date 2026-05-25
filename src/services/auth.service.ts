import * as bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { RegisterInput, LoginInput, OwnerRegisterInput } from '../validators/auth.validator';
import { UserRole } from '@prisma/client';
import { SALT_ROUNDS } from '../constants';

// ─── Slug helpers ─────────────────────────────────────────────────────────────

function toBaseSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function generateUniqueSlug(baseName: string): Promise<string> {
  const base = toBaseSlug(baseName);

  const exact = await prisma.restaurant.findUnique({ where: { slug: base } });
  if (!exact) return base;

  const existing = await prisma.restaurant.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });

  const taken = new Set(existing.map((r) => r.slug));
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// ─── Auth service ─────────────────────────────────────────────────────────────

export const authService = {
  async register(input: RegisterInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    return prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        role: UserRole.KITCHEN_STAFF,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        restaurantId: true,
        createdAt: true,
      },
    });
  },

  async registerOwner(input: OwnerRegisterInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    const slug = await generateUniqueSlug(input.restaurantName);
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    // Split ownerName into firstName and lastName for the User record
    const nameParts = input.ownerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    const result = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          name: input.restaurantName,
          slug,
          // Reusing user phone/email since specific restaurant fields don't exist on OwnerRegisterInput
          phone: input.phone,
          email: input.email,
          // Bootstrap default settings row alongside the restaurant
          settings: { create: {} },
        },
      });

      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName,
          lastName,
          phone: input.phone,
          role: UserRole.ADMIN,
          restaurantId: restaurant.id,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, restaurantId: true, createdAt: true,
        },
      });

      return { user, restaurant };
    });

    const accessToken = signAccessToken({
      id: result.user.id,
      role: result.user.role,
      restaurantId: result.restaurant.id
    });
    const refreshToken = signRefreshToken(result.user.id);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId: result.user.id, refreshToken, expiresAt } });

    return { accessToken, refreshToken, user: result.user, restaurant: result.restaurant };
  },

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const accessToken = signAccessToken({
      id: user.id,
      role: user.role,
      restaurantId: user.restaurantId ?? null
    });
    const refreshToken = signRefreshToken(user.id);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId: user.id, refreshToken, expiresAt } });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id, email: user.email, firstName: user.firstName,
        lastName: user.lastName, role: user.role, restaurantId: user.restaurantId,
      },
    };
  },

  /**
   * Refresh access + refresh tokens.
   */
  async refresh(refreshToken: string) {
    // Cast to any to safely extract ID depending on your jwt utility's exact return type
    const payload: any = verifyRefreshToken(refreshToken);
    if (!payload) throw ApiError.unauthorized('Invalid or expired refresh token');

    const targetUserId = typeof payload === 'string' ? payload : (payload.id || payload.sub);

    const session = await prisma.session.findUnique({ where: { refreshToken } });
    if (!session || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token revoked or expired');
    }

    const user = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user || !user.isActive) throw ApiError.unauthorized('User not found or inactive');

    // Rotate: delete old session, create a new one
    const newRefreshToken = signRefreshToken(user.id);
    const newAccessToken = signAccessToken({
      id: user.id,
      role: user.role,
      restaurantId: user.restaurantId ?? null
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.$transaction([
      prisma.session.delete({ where: { refreshToken } }),
      prisma.session.create({ data: { userId: user.id, refreshToken: newRefreshToken, expiresAt } }),
    ]);

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  },

  async logout(refreshToken: string) {
    await prisma.session.deleteMany({ where: { refreshToken } });
  },

  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, role: true, restaurantId: true, lastLoginAt: true, createdAt: true,
      },
    });
    if (!user) throw ApiError.notFound('User not found');
    return user;
  },
};
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

    const result = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          name: input.restaurantName,
          slug,
          phone: input.restaurantPhone,
          email: input.restaurantEmail,
          // Bootstrap default settings row alongside the restaurant
          settings: { create: {} },
        },
      });

      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
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

    const accessToken  = signAccessToken({ sub: result.user.id, role: result.user.role, restaurantId: result.restaurant.id });
    const refreshToken = signRefreshToken({ sub: result.user.id });

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

    const accessToken  = signAccessToken({ sub: user.id, role: user.role, restaurantId: user.restaurantId ?? undefined });
    const refreshToken = signRefreshToken({ sub: user.id });

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
   *
   * The axios call from the frontend sends an empty request body — this is
   * intentional. The refresh token is transmitted exclusively via the
   * HttpOnly cookie set with path=/v1/auth/refresh.  Sending it in the body
   * would expose it to JavaScript and defeat the HttpOnly protection.
   *
   * The cookie path restriction (/v1/auth/refresh) ensures the browser only
   * attaches the cookie to this single endpoint, limiting the CSRF attack surface.
   */
  async refresh(refreshToken: string) {
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) throw ApiError.unauthorized('Invalid or expired refresh token');

    const session = await prisma.session.findUnique({ where: { refreshToken } });
    if (!session || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token revoked or expired');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw ApiError.unauthorized('User not found or inactive');

    // Rotate: delete old session, create a new one
    const newRefreshToken = signRefreshToken({ sub: user.id });
    const newAccessToken  = signAccessToken({ sub: user.id, role: user.role, restaurantId: user.restaurantId ?? undefined });

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

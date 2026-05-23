import * as bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { RegisterInput, LoginInput, OwnerRegisterInput } from '../validators/auth.validator';
import { UserRole } from '@prisma/client';

const SALT_ROUNDS = 12;

// ─── Slug helpers ─────────────────────────────────────────────────────────────

/**
 * Converts a restaurant name into a URL-safe slug:
 *   "The Spice Garden!" → "the-spice-garden"
 */
function toBaseSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // strip symbols
    .replace(/\s+/g, '-')          // spaces → hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '');        // trim leading/trailing hyphens
}

/**
 * Returns a unique slug by appending -2, -3, … on collisions.
 * Called inside a transaction so the slug read and restaurant write are atomic.
 */
async function generateUniqueSlug(baseName: string): Promise<string> {
  const base = toBaseSlug(baseName);

  // Check exact match first
  const exact = await prisma.restaurant.findUnique({ where: { slug: base } });
  if (!exact) return base;

  // Find all slugs that start with base (base, base-2, base-3, …)
  const existing = await prisma.restaurant.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });

  const taken = new Set(existing.map((r) => r.slug));
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

// ─── Auth service ─────────────────────────────────────────────────────────────

export const authService = {
  // ── Existing: staff registration (KITCHEN_STAFF) ──────────────────────────
  async register(input: RegisterInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const user = await prisma.user.create({
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

    return user;
  },

  // ── New: owner + restaurant registration ──────────────────────────────────
  async registerOwner(input: OwnerRegisterInput) {
    // 1. Guard: email must be globally unique
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    // 2. Split ownerName into first/last (best-effort)
    const nameParts = input.ownerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '-';

    // 3. Generate unique slug (must happen before the transaction so we can
    //    pass the resolved slug in — Prisma interactive transactions support
    //    this pattern cleanly).
    const slug = await generateUniqueSlug(input.restaurantName);

    // 4. Hash password
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    // 5. Atomic: create restaurant + admin user together
    const { restaurant, user } = await prisma.$transaction(async (tx) => {
      // Re-check slug inside transaction to prevent race conditions
      const slugConflict = await tx.restaurant.findUnique({ where: { slug } });
      if (slugConflict) {
        // Extremely rare race — just throw; client can retry
        throw ApiError.conflict('Restaurant name already taken, please try a variation', 'SLUG_CONFLICT');
      }

      const restaurant = await tx.restaurant.create({
        data: {
          name: input.restaurantName,
          slug,
          phone: input.phone,
          email: input.email,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          email: true,
          phone: true,
          isActive: true,
          createdAt: true,
        },
      });

      const user = await tx.user.create({
        data: {
          restaurantId: restaurant.id,
          email: input.email,
          passwordHash,
          firstName,
          lastName,
          phone: input.phone,
          role: UserRole.ADMIN,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          restaurantId: true,
          createdAt: true,
        },
      });

      return { restaurant, user };
    });

    // 6. Issue tokens (same shape as login — JWT contains restaurantId)
    const authUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId,
    };

    const accessToken = signAccessToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user,
      restaurant,
    };
  },

  // ── Existing: login ───────────────────────────────────────────────────────
  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

    const authUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId,
    };

    const accessToken = signAccessToken(authUser);
    const refreshToken = signRefreshToken(user.id);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        restaurantId: user.restaurantId,
      },
    };
  },

  // ── Existing: refresh ─────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    const payload = verifyRefreshToken(refreshToken);

    const session = await prisma.session.findUnique({ where: { refreshToken } });
    if (!session || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token invalid or expired', 'TOKEN_INVALID');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw ApiError.unauthorized('User not found');

    const authUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId,
    };

    const newAccessToken = signAccessToken(authUser);
    const newRefreshToken = signRefreshToken(user.id);

    await prisma.session.update({
      where: { refreshToken },
      data: {
        refreshToken: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  },

  // ── Existing: logout ──────────────────────────────────────────────────────
  async logout(refreshToken: string) {
    await prisma.session.deleteMany({ where: { refreshToken } });
  },

  // ── Existing: me ──────────────────────────────────────────────────────────
  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        restaurantId: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) throw ApiError.notFound('User not found');
    return user;
  },
};

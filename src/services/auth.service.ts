import * as bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import {
  RegisterInput,
  LoginInput,
  OwnerRegisterInput,
  StaffLoginInput,
} from '../validators/auth.validator';
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

// ─── Restaurant code generator ────────────────────────────────────────────────
// Generates a unique 6-char alphanumeric code in the format [A-Z0-9]{6}.
// Collision probability is negligible for restaurant-scale usage, but we retry
// up to 5 times to be safe.

function generateRestaurantCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function generateUniqueRestaurantCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = generateRestaurantCode();
    const existing = await prisma.restaurant.findUnique({ where: { restaurantCode: code } });
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique restaurant code after 5 attempts');
}

// ─── Auth service ─────────────────────────────────────────────────────────────

export const authService = {
  /**
   * Staff registration — ADMIN-only endpoint.
   *
   * Creates a KITCHEN_STAFF (or specified role) user and associates them with
   * the calling admin's restaurant. This prevents the "no restaurantId" bug
   * where a staff user could log in but receive 403 on every settings request.
   *
   * The `restaurantId` is injected by the controller from the authenticated
   * admin's JWT — staff cannot choose their own restaurant association.
   */
  async register(input: RegisterInput, restaurantId: string) {
    if (!restaurantId) {
      throw ApiError.forbidden(
        'Cannot create staff account: the calling admin has no restaurant association.',
      );
    }

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    return prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        role: UserRole.KITCHEN_STAFF,
        restaurantId,
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
    const restaurantCode = await generateUniqueRestaurantCode();
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const nameParts = input.ownerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    const result = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          name: input.restaurantName,
          slug,
          restaurantCode,
          phone: input.phone,
          email: input.email,
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
      email: result.user.email,
      role: result.user.role,
      restaurantId: result.restaurant.id,
    });
    const refreshToken = signRefreshToken(result.user.id);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId: result.user.id, refreshToken, expiresAt } });

    return {
      accessToken,
      refreshToken,
      user: result.user,
      restaurant: {
        id: result.restaurant.id,
        name: result.restaurant.name,
        slug: result.restaurant.slug,
        restaurantCode: result.restaurant.restaurantCode,
      },
    };
  },

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId ?? null,
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
   * Staff PIN login flow:
   * 1. Resolve the restaurant by restaurantCode.
   * 2. Find the staff user by email within that restaurant.
   *    (Staff use a numeric PIN — we match on the 4-digit pin field only.)
   *    Since staff don't have unique identifiers beyond their PIN, we look up
   *    all active staff in the restaurant and check bcrypt.compare for each.
   *    Restaurant staff counts are small (< 50), so this is acceptable.
   * 3. Issue a short-lived access token (no refresh cookie for PIN sessions).
   *
   * Security notes:
   * - Constant-time comparison via bcrypt prevents timing attacks.
   * - PIN brute-force is protected by the shared authRateLimiter.
   * - staffPin is never returned in any API response or JWT.
   */
  async loginStaff(input: StaffLoginInput) {
    // 1. Find restaurant by code (case-insensitive via toUpperCase in validator)
    const restaurant = await prisma.restaurant.findUnique({
      where: { restaurantCode: input.restaurantCode },
      select: { id: true, name: true, slug: true, restaurantCode: true, isActive: true },
    });

    // Use the same generic error for both "restaurant not found" and "wrong PIN"
    // to avoid leaking valid restaurant codes via error messages.
    const INVALID_ERR = ApiError.unauthorized('Invalid restaurant code or PIN', 'INVALID_STAFF_CREDENTIALS');

    if (!restaurant || !restaurant.isActive) throw INVALID_ERR;

    // 2. Fetch all active staff for this restaurant that have a PIN set
    const staffList = await prisma.user.findMany({
      where: {
        restaurantId: restaurant.id,
        isActive: true,
        role: { in: [UserRole.KITCHEN_STAFF, UserRole.WAITER] },
        staffPin: { not: null },
      },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        role: true, restaurantId: true, staffPin: true,
      },
    });

    if (staffList.length === 0) throw INVALID_ERR;

    // 3. Find the staff member whose PIN matches (bcrypt compare)
    let matchedStaff: (typeof staffList)[0] | null = null;
    for (const staff of staffList) {
      if (staff.staffPin && await bcrypt.compare(input.pin, staff.staffPin)) {
        matchedStaff = staff;
        break;
      }
    }

    if (!matchedStaff) throw INVALID_ERR;

    // 4. Update lastLoginAt
    await prisma.user.update({
      where: { id: matchedStaff.id },
      data: { lastLoginAt: new Date() },
    });

    // 5. Issue access token — staff PIN sessions use same JWT shape as email/password
    //    so all existing RBAC middleware works without any changes.
    const accessToken = signAccessToken({
      id: matchedStaff.id,
      email: matchedStaff.email,
      role: matchedStaff.role,
      restaurantId: restaurant.id,
    });

    // Staff get a refresh token too so they stay logged in during a shift
    const refreshToken = signRefreshToken(matchedStaff.id);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12-hour shift session
    await prisma.session.create({
      data: { userId: matchedStaff.id, refreshToken, expiresAt },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: matchedStaff.id,
        email: matchedStaff.email,
        firstName: matchedStaff.firstName,
        lastName: matchedStaff.lastName,
        role: matchedStaff.role,
        restaurantId: restaurant.id,
      },
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        restaurantCode: restaurant.restaurantCode,
      },
    };
  },

  async refresh(refreshToken: string) {
    const payload = verifyRefreshToken(refreshToken);
    const targetUserId = payload.sub;

    const session = await prisma.session.findUnique({ where: { refreshToken } });
    if (!session || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token revoked or expired');
    }

    const user = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user || !user.isActive) throw ApiError.unauthorized('User not found or inactive');

    const newRefreshToken = signRefreshToken(user.id);
    const newAccessToken = signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurantId ?? null,
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

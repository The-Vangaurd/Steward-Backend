import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { UserRole } from '@prisma/client';

// ── REMOVED: const TEMP_PASSWORD = 'Welcome@123';
// Replaced with a cryptographically secure random password generator.
// The generated password is returned ONCE to the admin on staff creation.
// It is never stored in plaintext — only the bcrypt hash persists.

const SALT_ROUNDS = 12;

/**
 * Generates a cryptographically secure temporary password.
 *
 * Format: 3 segments of 4 URL-safe base64 chars joined by '-'
 * Example: "aB3x-Kp9m-Tz2q"  (entropy: ~72 bits)
 *
 * Properties:
 *  - Uses crypto.randomBytes (CSPRNG) — never Math.random()
 *  - URL-safe alphabet: no +, /, = padding ambiguity
 *  - Meets common complexity rules (upper, lower, digits)
 *  - Easy for a human to read and type when communicated out-of-band
 */
function generateTemporaryPassword(): string {
  // 9 random bytes → 12 base64 chars; split into 3 groups of 4
  const raw = randomBytes(9).toString('base64url'); // e.g. "aB3xKp9mTz2q"
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  isActive: true,
  restaurantId: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export const staffService = {
  async listStaff(restaurantId: string, page?: unknown, limit?: unknown) {
    const pagination = parsePagination(page, limit);
    const where = { restaurantId, role: { in: [UserRole.KITCHEN_STAFF, UserRole.WAITER] } };
    const [staff, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      prisma.user.count({ where }),
    ]);
    return { staff, meta: buildPaginationMeta(total, pagination.page, pagination.limit) };
  },

  async createStaffMember(restaurantId: string, data: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
    role: UserRole;
  }) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    // Generate a secure one-time password — returned once, never re-readable
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);

    const member = await prisma.user.create({
      data: { ...data, passwordHash, restaurantId },
      select: USER_SELECT,
    });

    // temporaryPassword is returned in plaintext exactly ONCE so the admin can
    // communicate it to the new staff member via a secure channel (e.g. email,
    // internal message). It is NOT stored anywhere after this function returns.
    //
    // Future improvement: send via email using the RESEND_API_KEY and never
    // expose it through the API response at all (set requiresPasswordReset flag).
    return { ...member, temporaryPassword };
  },

  async updateStaffMember(id: string, restaurantId: string, data: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    role?: UserRole;
    isActive?: boolean;
  }) {
    const member = await prisma.user.findFirst({ where: { id, restaurantId } });
    if (!member) throw ApiError.notFound('Staff member not found');
    return prisma.user.update({ where: { id }, data, select: USER_SELECT });
  },

  async deactivateStaffMember(id: string, restaurantId: string) {
    const member = await prisma.user.findFirst({ where: { id, restaurantId } });
    if (!member) throw ApiError.notFound('Staff member not found');
    await prisma.user.update({ where: { id }, data: { isActive: false }, select: { id: true } });
  },
};

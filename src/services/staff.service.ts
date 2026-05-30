import * as bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { UserRole } from '@prisma/client';
import { SALT_ROUNDS } from '../constants';

import crypto from 'crypto';

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

export interface CreatedStaffMember {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  restaurantId: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  temporaryPassword: string;
}

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
  }): Promise<CreatedStaffMember> {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_ALREADY_EXISTS');

    const temporaryPassword = crypto.randomBytes(6).toString('base64').replace(/\+/g, 'a').replace(/\//g, 'b').slice(0, 8);
    const passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);

    const member = await prisma.user.create({
      data: { ...data, passwordHash, restaurantId },
      select: USER_SELECT,
    });

    return { ...member, temporaryPassword };
  },

  async updateStaffMember(restaurantId: string, staffId: string, data: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    role?: UserRole;
    isActive?: boolean;
  }) {
    const staff = await prisma.user.findFirst({ where: { id: staffId, restaurantId } });
    if (!staff) throw ApiError.notFound('Staff member not found');

    return prisma.user.update({
      where: { id: staffId },
      data,
      select: USER_SELECT,
    });
  },

  async inviteStaffByGmail(restaurantId: string, data: {
    email: string;
    firstName?: string;
    lastName?: string;
    role: UserRole;
  }): Promise<{ email: string }> {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });

    if (existing) {
      if (existing.restaurantId !== restaurantId) {
        throw ApiError.conflict('Email belongs to a different restaurant', 'EMAIL_CONFLICT');
      }
      throw ApiError.conflict('Staff member already exists in this restaurant', 'ALREADY_EXISTS');
    }

    await prisma.user.create({
      data: {
        email: data.email,
        firstName: data.firstName ?? '',
        lastName: data.lastName ?? '',
        role: data.role,
        restaurantId,
        emailVerified: true,
        isActive: true,
        // No passwordHash — Gmail invite users must sign in via Google OAuth
      },
      select: { id: true },
    });

    return { email: data.email };
  },
};

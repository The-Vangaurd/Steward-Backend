import * as bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { UserRole } from '@prisma/client';
import { SALT_ROUNDS } from '../constants';

const TEMP_PASSWORD = 'Welcome@123';

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

    const passwordHash = await bcrypt.hash(TEMP_PASSWORD, SALT_ROUNDS);

    return prisma.user.create({
      data: { ...data, passwordHash, restaurantId },
      select: USER_SELECT,
    });
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

  async deleteStaffMember(restaurantId: string, staffId: string) {
    const staff = await prisma.user.findFirst({ where: { id: staffId, restaurantId } });
    if (!staff) throw ApiError.notFound('Staff member not found');
    await prisma.user.delete({ where: { id: staffId } });
  },
};

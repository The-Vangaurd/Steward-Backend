import { prisma } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { Shift } from '@prisma/client';

export const shiftService = {
  async listShifts(restaurantId: string) {
    const shifts = await prisma.shift.findMany({
      where: { restaurantId },
      orderBy: [
        { dayOfWeek: 'asc' },
        { startTime: 'asc' }
      ]
    });

    const grouped: Record<number, Shift[]> = {
      0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: []
    };

    for (const shift of shifts) {
      if (grouped[shift.dayOfWeek] !== undefined) {
        grouped[shift.dayOfWeek].push(shift);
      }
    }

    return { grouped, flat: shifts };
  },

  async createShift(restaurantId: string, data: {
    name: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }) {
    return prisma.shift.create({
      data: {
        ...data,
        restaurantId
      }
    });
  },

  async updateShift(restaurantId: string, id: string, data: {
    name?: string;
    startTime?: string;
    endTime?: string;
  }) {
    const shift = await prisma.shift.findFirst({
      where: { id, restaurantId }
    });
    if (!shift) throw ApiError.notFound('Shift not found');

    return prisma.shift.update({
      where: { id },
      data
    });
  },

  async toggleShift(restaurantId: string, id: string) {
    const shift = await prisma.shift.findFirst({
      where: { id, restaurantId }
    });
    if (!shift) throw ApiError.notFound('Shift not found');

    return prisma.shift.update({
      where: { id },
      data: { isEnabled: !shift.isEnabled }
    });
  },

  async deleteShift(restaurantId: string, id: string) {
    const shift = await prisma.shift.findFirst({
      where: { id, restaurantId }
    });
    if (!shift) throw ApiError.notFound('Shift not found');

    await prisma.shift.delete({
      where: { id }
    });
    return { success: true };
  }
};

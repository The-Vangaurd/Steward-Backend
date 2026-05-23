import { prisma } from '../config/database';
import { cacheGet, cacheSet } from '../utils/redis';
import { CACHE_TTL } from '../constants';
import { OrderStatus } from '@prisma/client';

export const analyticsService = {
  async getSummary(restaurantId: string, from: Date, to: Date) {
    const cacheKey = `analytics:summary:${restaurantId}:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const [totalOrders, completedOrders, cancelledOrders, revenueResult, prepOrders] = await Promise.all([
      prisma.order.count({ where: { restaurantId, createdAt: { gte: from, lte: to } } }),
      prisma.order.count({
        where: { restaurantId, status: OrderStatus.DELIVERED, createdAt: { gte: from, lte: to } },
      }),
      prisma.order.count({
        where: { restaurantId, status: OrderStatus.CANCELLED, createdAt: { gte: from, lte: to } },
      }),
      prisma.order.aggregate({
        where: { restaurantId, status: OrderStatus.DELIVERED, createdAt: { gte: from, lte: to } },
        _sum: { totalAmount: true },
      }),
      prisma.order.findMany({
        where: {
          restaurantId,
          status: OrderStatus.DELIVERED,
          createdAt: { gte: from, lte: to },
          confirmedAt: { not: null },
          readyAt: { not: null },
        },
        select: { confirmedAt: true, readyAt: true },
      }),
    ]);

    const avgPrepTimeMins = prepOrders.length > 0
      ? prepOrders.reduce((sum, o) => {
          const diffMs = o.readyAt!.getTime() - o.confirmedAt!.getTime();
          return sum + diffMs / 60_000;
        }, 0) / prepOrders.length
      : 0;

    const summary = {
      totalOrders,
      completedOrders,
      cancelledOrders,
      cancellationRate: totalOrders > 0 ? (cancelledOrders / totalOrders) * 100 : 0,
      totalRevenue: revenueResult._sum.totalAmount ?? 0,
      avgPrepTimeMins: Math.round(avgPrepTimeMins * 10) / 10,
    };

    await cacheSet(cacheKey, summary, CACHE_TTL.ANALYTICS);
    return summary;
  },

  async getRevenueSeries(restaurantId: string, from: Date, to: Date) {
    const orders = await prisma.order.findMany({
      where: {
        restaurantId,
        status: OrderStatus.DELIVERED,
        createdAt: { gte: from, lte: to },
      },
      select: { createdAt: true, totalAmount: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by date
    const byDate = new Map<string, number>();
    for (const order of orders) {
      const key = order.createdAt.toISOString().slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + Number(order.totalAmount));
    }

    return Array.from(byDate.entries()).map(([date, revenue]) => ({ date, revenue }));
  },

  async getTopItems(restaurantId: string, from: Date, to: Date, take = 10) {
    const result = await prisma.orderItem.groupBy({
      by: ['menuItemId', 'name'],
      where: {
        order: {
          restaurantId,
          status: OrderStatus.DELIVERED,
          createdAt: { gte: from, lte: to },
        },
      },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take,
    });

    return result.map((r) => ({
      menuItemId: r.menuItemId,
      name: r.name,
      totalQuantity: r._sum.quantity ?? 0,
      totalRevenue: r._sum.subtotal ?? 0,
    }));
  },

  async getHourlyDistribution(restaurantId: string, from: Date, to: Date) {
    const orders = await prisma.order.findMany({
      where: { restaurantId, createdAt: { gte: from, lte: to } },
      select: { createdAt: true },
    });

    const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    for (const order of orders) {
      byHour[order.createdAt.getHours()].count++;
    }

    return byHour;
  },

  async aggregateDailyAnalytics(restaurantId: string, date: Date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    await prisma.$transaction(async (tx) => {
      const [total, completed, cancelled, revenue, prepOrders] = await Promise.all([
        tx.order.count({
          where: { restaurantId, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        tx.order.count({
          where: { restaurantId, status: OrderStatus.DELIVERED, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        tx.order.count({
          where: { restaurantId, status: OrderStatus.CANCELLED, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        tx.order.aggregate({
          where: { restaurantId, status: OrderStatus.DELIVERED, createdAt: { gte: startOfDay, lte: endOfDay } },
          _sum: { totalAmount: true },
        }),
        tx.order.findMany({
          where: {
            restaurantId,
            status: OrderStatus.DELIVERED,
            createdAt: { gte: startOfDay, lte: endOfDay },
            confirmedAt: { not: null },
            readyAt: { not: null },
          },
          select: { confirmedAt: true, readyAt: true },
        }),
      ]);

      const avgPrepTimeMins = prepOrders.length > 0
        ? prepOrders.reduce((sum, o) => {
            const diffMs = o.readyAt!.getTime() - o.confirmedAt!.getTime();
            return sum + diffMs / 60_000;
          }, 0) / prepOrders.length
        : 0;

      await tx.dailyAnalytics.upsert({
        where: { restaurantId_date: { restaurantId, date: startOfDay } },
        create: {
          restaurantId,
          date: startOfDay,
          totalOrders: total,
          completedOrders: completed,
          cancelledOrders: cancelled,
          totalRevenue: revenue._sum.totalAmount ?? 0,
          avgPrepTimeMins: Math.round(avgPrepTimeMins * 10) / 10,
        },
        update: {
          totalOrders: total,
          completedOrders: completed,
          cancelledOrders: cancelled,
          totalRevenue: revenue._sum.totalAmount ?? 0,
          avgPrepTimeMins: Math.round(avgPrepTimeMins * 10) / 10,
        },
      });
    });
  },
};

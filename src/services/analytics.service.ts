import { prisma } from '../config/database';
import { cacheGet, cacheSet } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL } from '../constants';
import { OrderStatus } from '@prisma/client';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Formats a Date as a YYYY-MM-DD string for use in cache keys. */
const dateKey = (d: Date): string => d.toISOString().slice(0, 10);

// ── Service ───────────────────────────────────────────────────────────────────

export const analyticsService = {
  async getSummary(restaurantId: string, from: Date, to: Date) {
    const cacheKey = CACHE_KEYS.analyticsSummary(restaurantId, dateKey(from), dateKey(to));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const [totalOrders, completedOrders, cancelledOrders, revenueResult, prepOrders] = await Promise.all([
      prisma.order.count({ where: { restaurantId, createdAt: { gte: from, lte: to } } }),
      prisma.order.count({
        where: { restaurantId, status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } },
      }),
      prisma.order.count({
        where: { restaurantId, status: OrderStatus.CANCELLED, createdAt: { gte: from, lte: to } },
      }),
      prisma.order.aggregate({
        where: { restaurantId, status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } },
        _sum: { totalAmount: true },
      }),
      // Prep time: readyAt - startedPreparingAt (time kitchen was actually cooking)
      prisma.order.findMany({
        where: {
          restaurantId,
          status: OrderStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
          startedPreparingAt: { not: null },
          readyAt: { not: null },
        },
        select: { startedPreparingAt: true, readyAt: true },
      }),
    ]);

    const avgPrepTimeMins = prepOrders.length > 0
      ? prepOrders.reduce((sum, o) => {
          const diffMs = o.readyAt!.getTime() - o.startedPreparingAt!.getTime();
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
    const cacheKey = CACHE_KEYS.analyticsRevenue(restaurantId, dateKey(from), dateKey(to));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const orders = await prisma.order.findMany({
      where: {
        restaurantId,
        status: OrderStatus.COMPLETED,
        createdAt: { gte: from, lte: to },
      },
      select: { createdAt: true, totalAmount: true },
      orderBy: { createdAt: 'asc' },
    });

    const byDate = new Map<string, number>();
    for (const order of orders) {
      const key = order.createdAt.toISOString().slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + Number(order.totalAmount));
    }

    const series = Array.from(byDate.entries()).map(([date, revenue]) => ({ date, revenue }));
    await cacheSet(cacheKey, series, CACHE_TTL.ANALYTICS);
    return series;
  },

  async getTopItems(restaurantId: string, from: Date, to: Date, take = 10) {
    const cacheKey = CACHE_KEYS.analyticsTopItems(restaurantId, dateKey(from), dateKey(to));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const result = await prisma.orderItem.groupBy({
      by: ['menuItemId', 'name'],
      where: {
        order: {
          restaurantId,
          status: OrderStatus.COMPLETED,
          createdAt: { gte: from, lte: to },
        },
      },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take,
    });

    const topItems = result.map((r) => ({
      menuItemId: r.menuItemId,
      name: r.name,
      totalQuantity: r._sum.quantity ?? 0,
      totalRevenue: r._sum.subtotal ?? 0,
    }));

    await cacheSet(cacheKey, topItems, CACHE_TTL.ANALYTICS);
    return topItems;
  },

  async getHourlyDistribution(restaurantId: string, from: Date, to: Date) {
    const cacheKey = CACHE_KEYS.analyticsHourly(restaurantId, dateKey(from), dateKey(to));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const rows = await prisma.$queryRaw<{ hour: number; count: bigint }[]>`
      SELECT
        EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::bigint AS count
      FROM orders
      WHERE "restaurantId" = ${restaurantId}
        AND "createdAt" >= ${from}
        AND "createdAt" <= ${to}
      GROUP BY hour
      ORDER BY hour
    `;

    const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    for (const row of rows) {
      byHour[row.hour].count = Number(row.count);
    }

    await cacheSet(cacheKey, byHour, CACHE_TTL.ANALYTICS);
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
          where: { restaurantId, status: OrderStatus.COMPLETED, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        tx.order.count({
          where: { restaurantId, status: OrderStatus.CANCELLED, createdAt: { gte: startOfDay, lte: endOfDay } },
        }),
        tx.order.aggregate({
          where: { restaurantId, status: OrderStatus.COMPLETED, createdAt: { gte: startOfDay, lte: endOfDay } },
          _sum: { totalAmount: true },
        }),
        tx.order.findMany({
          where: {
            restaurantId,
            status: OrderStatus.COMPLETED,
            createdAt: { gte: startOfDay, lte: endOfDay },
            startedPreparingAt: { not: null },
            readyAt: { not: null },
          },
          select: { startedPreparingAt: true, readyAt: true },
        }),
      ]);

      // Prep time: READY - PREPARING (time the kitchen was actually cooking)
      const avgPrepTimeMins = prepOrders.length > 0
        ? prepOrders.reduce((sum, o) => {
            const diffMs = o.readyAt!.getTime() - o.startedPreparingAt!.getTime();
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

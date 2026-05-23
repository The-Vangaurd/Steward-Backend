import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { analyticsService } from '../services/analytics.service';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const connection = parseRedisUrl(env.REDIS_URL);

// ── Queue ─────────────────────────────────────────────────────────────────────

export const analyticsQueue = new Queue('analytics', { connection });

// ── Worker ────────────────────────────────────────────────────────────────────

export const startAnalyticsWorker = (): Worker => {
  const worker = new Worker(
    'analytics',
    async (job) => {
      if (job.name === 'daily-aggregate') {
        const { restaurantId, date } = job.data as { restaurantId: string; date: string };
        await analyticsService.aggregateDailyAnalytics(restaurantId, new Date(date));
        logger.info('Daily analytics aggregated', { restaurantId, date });
      }

      if (job.name === 'midnight-cron') {
        await scheduleAllDailyAnalytics();
      }
    },
    { connection: { ...parseRedisUrl(env.REDIS_URL) } },
  );

  worker.on('failed', (job, err) => {
    logger.error('Analytics job failed', { jobId: job?.id, error: err.message });
  });

  return worker;
};

// ── Midnight cron — fires at 00:00 UTC every day ──────────────────────────────

export const startAnalyticsCron = async (): Promise<void> => {
  // Remove any stale repeatable job from a previous deploy before re-registering,
  // so we don't accumulate duplicate schedules across restarts.
  const repeatables = await analyticsQueue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'midnight-cron') {
      await analyticsQueue.removeRepeatableByKey(job.key);
    }
  }

  await analyticsQueue.add(
    'midnight-cron',
    {},
    {
      repeat: { pattern: '0 0 * * *' }, // every day at midnight UTC
      jobId: 'midnight-cron',
    },
  );

  logger.info('Analytics midnight cron registered');
};

// ── Scheduler helper ──────────────────────────────────────────────────────────

export const scheduleAllDailyAnalytics = async (): Promise<void> => {
  const restaurants = await prisma.restaurant.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10);

  for (const restaurant of restaurants) {
    await analyticsQueue.add(
      'daily-aggregate',
      { restaurantId: restaurant.id, date: dateStr },
      { jobId: `daily-${restaurant.id}-${dateStr}`, removeOnComplete: true },
    );
  }

  logger.info(`Scheduled daily analytics for ${restaurants.length} restaurants`);
};

// ── Parse Redis URL for ioredis options ───────────────────────────────────────
function parseRedisUrl(url: string): { host: string; port: number; password?: string; tls?: object } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    ...(parsed.protocol === 'rediss:' && { tls: {} }),
  };
}
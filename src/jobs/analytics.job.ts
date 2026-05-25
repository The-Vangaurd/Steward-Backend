import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { analyticsService } from '../services/analytics.service';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ── Parse Redis URL for ioredis options ───────────────────────────────────────
function parseRedisUrl(url: string | undefined): { host: string; port: number; password?: string; tls?: object } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
      ...(parsed.protocol === 'rediss:' && { tls: {} }),
    };
  } catch (err) {
    logger.error('Failed to parse Redis URL', { url, error: (err as Error).message });
    return undefined;
  }
}

const connection = parseRedisUrl(env.REDIS_URL);

// ── Queue ─────────────────────────────────────────────────────────────────────
export const analyticsQueue = connection
  ? new Queue('analytics', { connection })
  : null;

// ── Worker ────────────────────────────────────────────────────────────────────
export const startAnalyticsWorker = (): Worker | null => {
  if (!connection) {
    logger.warn('Analytics worker not started (Redis not configured)');
    return null;
  }

  try {
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
      { connection },
    );

    worker.on('failed', (job, err) => {
      logger.error('Analytics job failed', { jobId: job?.id, error: err.message });
    });

    worker.on('error', (err) => {
      logger.error('Analytics worker error', { error: err.message });
    });

    return worker;
  } catch (err) {
    logger.error('Failed to start analytics worker', { error: (err as Error).message });
    return null;
  }
};

// ── Midnight cron — fires at 00:00 UTC every day ──────────────────────────────
export const startAnalyticsCron = async (): Promise<void> => {
  if (!analyticsQueue) {
    logger.warn('Analytics cron not registered (Queue is not initialized)');
    return;
  }

  try {
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
  } catch (err) {
    logger.error('Failed to register analytics cron', { error: (err as Error).message });
  }
};

// ── Scheduler helper ──────────────────────────────────────────────────────────
export const scheduleAllDailyAnalytics = async (): Promise<void> => {
  if (!analyticsQueue) {
    logger.warn('Daily analytics scheduling skipped (Queue is not initialized)');
    return;
  }

  try {
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
  } catch (err) {
    logger.error('Failed to schedule daily analytics', { error: (err as Error).message });
  }
};
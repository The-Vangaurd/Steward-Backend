import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { analyticsService } from '../services/analytics.service';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ── Redis connection config ────────────────────────────────────────────────────

function parseRedisUrl(
  url: string | undefined,
): { host: string; port: number; password?: string; tls?: object } | undefined {
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
    logger.error('Failed to parse Redis URL for BullMQ', { error: (err as Error).message });
    return undefined;
  }
}

const connection = parseRedisUrl(env.REDIS_URL);

// ── Queues (singletons) ───────────────────────────────────────────────────────
// PERF: Both queues are created once at module load time and reused.
// Previously, startSessionCleanupCron() created a new Queue instance on every
// call, leaking a Redis connection each time (each Queue opens its own socket).

export const analyticsQueue = connection
  ? new Queue('analytics', { connection })
  : null;

// PERF: Declare as module-level singleton so startSessionCleanupCron() only
// ever opens one Redis connection for the session-cleanup queue.
const sessionCleanupQueue = connection
  ? new Queue('session-cleanup', { connection })
  : null;

// ── Analytics Worker ──────────────────────────────────────────────────────────

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
          try {
            const { restaurantId, date } = job.data as { restaurantId: string; date: string };
            await analyticsService.aggregateDailyAnalytics(restaurantId, new Date(date));
            logger.info('Daily analytics aggregated', { restaurantId, date, jobId: job.id });
          } catch (err) {
            logger.error('daily-aggregate job failed', {
              jobId: job.id,
              data: job.data,
              error: (err as Error).message,
              stack: (err as Error).stack,
            });
            throw err;
          }
        }

        if (job.name === 'midnight-cron') {
          try {
            await scheduleAllDailyAnalytics();
          } catch (err) {
            logger.error('midnight-cron job failed', {
              jobId: job.id,
              error: (err as Error).message,
              stack: (err as Error).stack,
            });
            throw err;
          }
        }
      },
      { connection },
    );

    worker.on('failed', (job, err) => {
      logger.error('Analytics job failed', {
        jobId: job?.id,
        name: job?.name,
        error: err.message,
      });
    });

    worker.on('error', (err) => {
      logger.error('Analytics worker error (scheduler stability preserved)', {
        error: err.message,
      });
    });

    return worker;
  } catch (err) {
    logger.error('Failed to start analytics worker', { error: (err as Error).message });
    return null;
  }
};

// ── Midnight cron ─────────────────────────────────────────────────────────────

export const startAnalyticsCron = async (): Promise<void> => {
  if (!analyticsQueue) {
    logger.warn('Analytics cron not registered (Queue is not initialised)');
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
        repeat: { pattern: '0 0 * * *' },
        jobId: 'midnight-cron',
      },
    );

    logger.info('Analytics midnight cron registered');
  } catch (err) {
    logger.error('Failed to register analytics cron (non-fatal)', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
};

// ── Per-restaurant scheduler ──────────────────────────────────────────────────

export const scheduleAllDailyAnalytics = async (): Promise<void> => {
  if (!analyticsQueue) {
    logger.warn('Daily analytics scheduling skipped (Queue is not initialised)');
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
      try {
        await analyticsQueue.add(
          'daily-aggregate',
          { restaurantId: restaurant.id, date: dateStr },
          { jobId: `daily-${restaurant.id}-${dateStr}`, removeOnComplete: true },
        );
      } catch (err) {
        logger.error('Failed to enqueue daily-aggregate for restaurant', {
          restaurantId: restaurant.id,
          date: dateStr,
          error: (err as Error).message,
        });
      }
    }

    logger.info(`Scheduled daily analytics for ${restaurants.length} restaurants`, {
      date: dateStr,
    });
  } catch (err) {
    logger.error('Failed to schedule daily analytics batch', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
};

// ── Expired session cleanup cron ──────────────────────────────────────────────

export const startSessionCleanupCron = async (): Promise<void> => {
  // PERF: Use the module-level singleton queue instead of creating a new Queue
  // on every call.  The old code leaked a Redis connection each invocation.
  if (!sessionCleanupQueue) {
    logger.warn('Session cleanup cron not registered (Queue is not initialised)');
    return;
  }

  try {
    const repeatables = await sessionCleanupQueue.getRepeatableJobs();
    for (const job of repeatables) {
      if (job.name === 'cleanup-expired-sessions') {
        await sessionCleanupQueue.removeRepeatableByKey(job.key);
      }
    }

    await sessionCleanupQueue.add(
      'cleanup-expired-sessions',
      {},
      {
        repeat: { pattern: '0 3 * * *' }, // 03:00 UTC daily
        jobId: 'cleanup-expired-sessions',
      },
    );

    const worker = new Worker(
      'session-cleanup',
      async () => {
        try {
          const { count } = await prisma.session.deleteMany({
            where: { expiresAt: { lt: new Date() } },
          });
          logger.info('Expired sessions cleaned up', { deletedCount: count });
        } catch (err) {
          logger.error('Session cleanup job failed', { error: (err as Error).message });
          throw err;
        }
      },
      { connection: connection! },
    );

    worker.on('error', (err) => {
      logger.error('Session cleanup worker error', { error: err.message });
    });

    logger.info('Session cleanup cron registered');
  } catch (err) {
    logger.error('Failed to register session cleanup cron (non-fatal)', {
      error: (err as Error).message,
    });
  }
};

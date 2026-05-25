import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { analyticsService } from '../services/analytics.service';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ── Redis connection config ────────────────────────────────────────────────────

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
    logger.error('Failed to parse Redis URL for BullMQ', { error: (err as Error).message });
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
        // Each job handler wrapped in try/catch so one failure doesn't
        // crash the worker process and break the scheduler.
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
            throw err; // re-throw so BullMQ marks the job as failed
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
      logger.error('Analytics job failed', { jobId: job?.id, name: job?.name, error: err.message });
    });

    worker.on('error', (err) => {
      // Worker-level errors (e.g. Redis disconnect) are logged but do NOT
      // crash the process — the scheduler continues running.
      logger.error('Analytics worker error (scheduler stability preserved)', { error: err.message });
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
    logger.warn('Analytics cron not registered (Queue is not initialised)');
    return;
  }

  try {
    // Remove any stale repeatable before re-registering (idempotent startup)
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
    // Log but do not rethrow — a cron registration failure must not prevent
    // the HTTP server from starting.
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
        // Per-restaurant failures are logged individually so one bad ID
        // doesn't abort the rest of the batch.
        logger.error('Failed to enqueue daily-aggregate for restaurant', {
          restaurantId: restaurant.id,
          date: dateStr,
          error: (err as Error).message,
        });
      }
    }

    logger.info(`Scheduled daily analytics for ${restaurants.length} restaurants`, { date: dateStr });
  } catch (err) {
    logger.error('Failed to schedule daily analytics batch', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
};

// ── Expired session cleanup cron ──────────────────────────────────────────────

export const startSessionCleanupCron = async (): Promise<void> => {
  if (!analyticsQueue) {
    logger.warn('Session cleanup cron not registered (Queue is not initialised)');
    return;
  }

  try {
    const queue = new Queue('session-cleanup', { connection: connection! });

    const repeatables = await queue.getRepeatableJobs();
    for (const job of repeatables) {
      if (job.name === 'cleanup-expired-sessions') {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    await queue.add(
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
    logger.error('Failed to register session cleanup cron (non-fatal)', { error: (err as Error).message });
  }
};

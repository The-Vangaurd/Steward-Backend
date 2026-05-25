import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

// ── Redis client (optional) ───────────────────────────────────────────────────
//
// Redis is treated as a non-critical dependency. If REDIS_URL is absent or the
// connection fails, the server boots in "degraded mode":
//  - Rate-limiting falls back to in-memory (express-rate-limit default store)
//  - Caching features are disabled
//  - Analytics BullMQ jobs are skipped (handled in analytics.job.ts)
//
// The server does NOT crash. Degraded mode is logged clearly so ops can act.

export let redis: Redis | null = null;
export let REDIS_DEGRADED = false;

export const connectRedis = async (): Promise<void> => {
  if (!env.REDIS_URL) {
    logger.warn('[redis] REDIS_URL not set — running in degraded mode (no cache, no queues)');
    REDIS_DEGRADED = true;
    return;
  }

  try {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,   // fail fast on command-level errors
      enableReadyCheck: false,
      lazyConnect: true,
      // Retry strategy: back off quickly and give up — don't hold up boot
      retryStrategy: (times) => {
        if (times >= 3) return null; // stop retrying, let the error surface
        return Math.min(times * 200, 1000);
      },
    });

    // Wire up persistent event handlers BEFORE connect() so we don't miss events
    client.on('error', (err) => {
      logger.error('[redis] Connection error', { error: err.message });
      if (!REDIS_DEGRADED) {
        REDIS_DEGRADED = true;
        logger.warn('[redis] Entering degraded mode — cache and queues disabled');
      }
    });

    client.on('close', () => {
      logger.warn('[redis] Connection closed');
    });

    client.on('reconnecting', (delay: number) => {
      logger.info(`[redis] Reconnecting in ${delay}ms`);
    });

    client.on('ready', () => {
      REDIS_DEGRADED = false;
      logger.info('[redis] Connection ready');
    });

    // connect() can throw if the host is unreachable within the retry budget
    await client.connect();

    redis = client;
    logger.info('[redis] Connected successfully');
  } catch (err) {
    // ⚠️  Do NOT rethrow — a Redis failure must never prevent the HTTP server
    // from starting. The catch in src/index.ts around connectRedis() provides
    // a second safety net, but this inner catch is the primary guard.
    REDIS_DEGRADED = true;
    logger.warn('[redis] Failed to connect — running in degraded mode', {
      error: (err as Error).message,
    });
    logger.warn(
      '[redis] Degraded mode active: rate limiting uses memory store, ' +
      'caching is disabled, BullMQ jobs will not start.',
    );
  }
};

export const checkRedisConnection = async (): Promise<boolean> => {
  try {
    if (!redis || REDIS_DEGRADED) return false;
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
};

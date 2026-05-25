import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

export let redis: Redis | null = null;

export const connectRedis = async (): Promise<void> => {
  try {
    if (!env.REDIS_URL) {
      logger.warn('REDIS_URL missing. Redis disabled.');
      return;
    }

    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      logger.error('Redis error', {
        error: err.message,
      });
    });

    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });

    await redis.connect();

    logger.info('Redis connected');
  } catch (err) {
    logger.error('Redis initialization failed', {
      error: (err as Error).message,
    });

    redis = null;
  }
};
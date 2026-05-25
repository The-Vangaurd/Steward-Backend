import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  })
  : null;

export const connectRedis = async (): Promise<void> => {
  try {
    if (!redis) {
      logger.warn('Redis disabled');
      return;
    }

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
  }
};

export const checkRedisConnection = async (): Promise<boolean> => {
  try {
    if (!redis) return false;

    const pong = await redis.ping();

    return pong === 'PONG';
  } catch {
    return false;
  }
};
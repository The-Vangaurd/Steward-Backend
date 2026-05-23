import { redis } from '../config/redis';
import { logger } from './logger';

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  try {
    const value = await redis.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch (err) {
    logger.warn('Cache get failed', { key, error: (err as Error).message });
    return null;
  }
};

export const cacheSet = async (
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('Cache set failed', { key, error: (err as Error).message });
  }
};

export const cacheDel = async (...keys: string[]): Promise<void> => {
  try {
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn('Cache del failed', { keys, error: (err as Error).message });
  }
};

export const cacheDelPattern = async (pattern: string): Promise<void> => {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn('Cache del pattern failed', {
      pattern,
      error: (err as Error).message,
    });
  }
};
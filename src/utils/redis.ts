import { redis } from '../config/redis';
import { logger } from './logger';

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  try {
    if (!redis) return null;
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
  ttlSeconds?: number,
): Promise<void> => {
  try {
    if (!redis) return;
    const stringified = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.set(key, stringified, 'EX', ttlSeconds);
    } else {
      await redis.set(key, stringified);
    }
  } catch (err) {
    logger.warn('Cache set failed', { key, error: (err as Error).message });
  }
};

export const cacheDel = async (...keys: string[]): Promise<void> => {
  try {
    if (!redis) return;
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn('Cache del failed', { keys, error: (err as Error).message });
  }
};

export const cacheDelPattern = async (pattern: string): Promise<void> => {
  try {
    if (!redis) return;
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn('Cache del pattern failed', {
      pattern,
      error: (err as Error).message,
    });
  }
};

// Aliases for compatibility
export const getCache = async (key: string): Promise<string | null> => {
  try {
    if (!redis) return null;
    return await redis.get(key);
  } catch {
    return null;
  }
};

export const setCache = async (
  key: string,
  value: string,
  ttl?: number,
): Promise<void> => {
  try {
    if (!redis) return;
    if (ttl) {
      await redis.set(key, value, 'EX', ttl);
    } else {
      await redis.set(key, value);
    }
  } catch {
    return;
  }
};

export const deleteCache = async (key: string): Promise<void> => {
  try {
    if (!redis) return;
    await redis.del(key);
  } catch {
    return;
  }
};

export const clearCacheByPattern = async (pattern: string): Promise<void> => {
  try {
    if (!redis) return;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    return;
  }
};
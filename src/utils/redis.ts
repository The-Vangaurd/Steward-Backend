import { redis } from '../config/redis';

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

export const clearCacheByPattern = async (
  pattern: string,
): Promise<void> => {
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
import { redis } from '../config/redis';
import { logger } from './logger';

// ── Generic typed cache helpers ───────────────────────────────────────────────

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

/**
 * Delete all keys matching a glob pattern using SCAN instead of KEYS.
 *
 * KEYS blocks the Redis event loop for the duration of the scan — dangerous
 * at scale. SCAN is O(1) per call and yields control between iterations.
 */
export const cacheDelPattern = async (pattern: string): Promise<void> => {
  try {
    if (!redis) return;

    let cursor = '0';
    const toDelete: string[] = [];

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      toDelete.push(...keys);
    } while (cursor !== '0');

    if (toDelete.length > 0) {
      // Delete in batches of 500 to avoid oversized DEL commands
      for (let i = 0; i < toDelete.length; i += 500) {
        await redis.del(...toDelete.slice(i, i + 500));
      }
    }
  } catch (err) {
    logger.warn('Cache del pattern failed', {
      pattern,
      error: (err as Error).message,
    });
  }
};

// ── String aliases (legacy compat) ────────────────────────────────────────────

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

/** @deprecated Use cacheDelPattern — this alias exists for backward compat */
export const clearCacheByPattern = cacheDelPattern;

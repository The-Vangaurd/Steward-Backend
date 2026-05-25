import { redis } from '../config/redis';

/**
 * Generates a sequential, human-readable order number.
 * Format: ORD-YYYYMMDD-XXXXX  (e.g. ORD-20240601-00042)
 * Falls back to a random sequence if Redis is disabled or offline.
 */
export const generateOrderNumber = async (restaurantId: string): Promise<string> => {
  const date = new Date();
  const dateStr = date
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  let seqStr: string;

  try {
    if (redis) {
      const counterKey = `order_counter:${restaurantId}:${dateStr}`;
      const seq = await redis.incr(counterKey);
      // expire after 2 days to keep Redis clean
      await redis.expire(counterKey, 172_800);
      seqStr = String(seq).padStart(5, '0');
    } else {
      // Fallback: generate a random 5-digit number if Redis is not configured
      const randomSeq = Math.floor(10000 + Math.random() * 90000);
      seqStr = String(randomSeq);
    }
  } catch {
    // Fallback on connection errors
    const randomSeq = Math.floor(10000 + Math.random() * 90000);
    seqStr = String(randomSeq);
  }

  return `ORD-${dateStr}-${seqStr}`;
};
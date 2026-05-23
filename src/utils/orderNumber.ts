import { redis } from '../config/redis';

/**
 * Generates a sequential, human-readable order number.
 * Format: ORD-YYYYMMDD-XXXXX  (e.g. ORD-20240601-00042)
 */
export const generateOrderNumber = async (restaurantId: string): Promise<string> => {
  const date = new Date();
  const dateStr = date
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  const counterKey = `order_counter:${restaurantId}:${dateStr}`;
  const seq = await redis.incr(counterKey);
  // expire after 2 days to keep Redis clean
  await redis.expire(counterKey, 172_800);

  const seqStr = String(seq).padStart(5, '0');
  return `ORD-${dateStr}-${seqStr}`;
};
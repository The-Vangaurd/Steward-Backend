import { redis } from '../config/redis';

export const generateOrderNumber = async (): Promise<string> => {
  try {
    if (!redis) {
      return `ORD-${Date.now()}`;
    }

    const counter = await redis.incr('order_counter');

    return `ORD-${counter}`;
  } catch {
    return `ORD-${Date.now()}`;
  }
};
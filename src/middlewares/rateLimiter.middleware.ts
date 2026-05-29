import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { HTTP_STATUS } from '../constants';
import { sendError } from '../utils/response';
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from '../config/redis';

function buildStore(prefix: string) {
  try {
    if (!redisClient) return undefined;
    return new RedisStore({
      sendCommand: (...args: string[]) => (redisClient as any).call(...args),
      prefix,
    });
  } catch {
    return undefined;
  }
}

export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:global:'),
  handler: (_req, res) => {
    sendError(
      res,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      'Too many requests, please try again later',
      'RATE_LIMIT_EXCEEDED',
    );
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:auth:'),
  handler: (_req, res) => {
    sendError(
      res,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      'Too many authentication attempts, please try again later',
      'RATE_LIMIT_EXCEEDED',
    );
  },
});

export const cancelRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:cancel:'),
  handler: (_req, res) => {
    sendError(
      res,
      HTTP_STATUS.TOO_MANY_REQUESTS,
      'Too many cancellation attempts, please try again later',
      'RATE_LIMIT_EXCEEDED',
    );
  },
});
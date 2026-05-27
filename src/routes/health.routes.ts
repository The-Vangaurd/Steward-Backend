import { Router, Request, Response } from 'express';
import { checkDatabaseConnection } from '../config/database';
import { checkRedisConnection } from '../config/redis';
import { env } from '../config/env';
import { HTTP_STATUS } from '../constants';
import { sendSuccess } from '../utils/response';

const router = Router();

// SECURE: Report live status for both database and Redis.
// Keeps HTTP status as 200 on Redis failures to report degraded health without triggering orchestration restarts.
router.get('/', async (_req: Request, res: Response) => {
  const [db, redis] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  const isRedisActive = !!env.REDIS_URL;
  const status = db && (!isRedisActive || redis)
    ? 'healthy'
    : !db
      ? 'unhealthy'
      : 'degraded';

  sendSuccess(
    res,
    status === 'unhealthy' ? HTTP_STATUS.SERVICE_UNAVAILABLE : HTTP_STATUS.OK,
    {
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      services: { 
        database: db, 
        redis: isRedisActive ? redis : 'disabled' 
      },
    },
  );
});

export default router;

import { Router, Request, Response } from 'express';
import { checkDatabaseConnection } from '../config/database';
import { checkRedisConnection } from '../config/redis';
import { env } from '../config/env';
import { HTTP_STATUS } from '../constants';
import { sendSuccess } from '../utils/response';

const router = Router();

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

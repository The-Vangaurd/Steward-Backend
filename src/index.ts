import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { env } from './config/env';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { initSocket } from './sockets';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { globalRateLimiter } from './middlewares/rateLimiter.middleware';

import { startAnalyticsWorker, startAnalyticsCron } from './jobs/analytics.job';

// ── Routes ────────────────────────────────────────────────────────────────────
import healthRouter from './routes/health.routes';
import authRouter from './routes/auth.routes';
import menuRouter from './routes/menu.routes';
import orderRouter from './routes/order.routes';
import analyticsRouter from './routes/analytics.routes';
import staffRouter from './routes/staff.routes';

const app = express();
const httpServer = http.createServer(app);

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or postman)
      if (!origin) return callback(null, true);

      const allowedOrigins = env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : [];

      // If no origins configured, default to allow the origin dynamically (safe with credentials)
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  }),
);

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.path === '/health',
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(globalRateLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/v1/auth', authRouter);
app.use('/v1/menu', menuRouter);
app.use('/v1/orders', orderRouter);
app.use('/v1/admin/analytics', analyticsRouter);
app.use('/v1/admin/staff', staffRouter);

// ── 404 & error handlers ──────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const start = async (): Promise<void> => {
  try {
    console.log('Starting backend...');
    console.log('Environment PORT:', env.PORT);

    // DATABASE
    await connectDatabase();
    logger.info('Database connected');

    // START SERVER FIRST
    httpServer.listen(env.PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${env.PORT} [${env.NODE_ENV}]`);
    });

    // REDIS (NON-BLOCKING)
    try {
      await connectRedis();
      logger.info('Redis connected');
    } catch (err) {
      logger.error('Redis connection failed', {
        error: (err as Error).message,
      });
    }

    // SOCKETS
    initSocket(httpServer);

    // BACKGROUND JOBS (NON-BLOCKING)
    if (env.NODE_ENV !== 'test') {
      try {
        startAnalyticsWorker();
        logger.info('Analytics worker started');

        await startAnalyticsCron();
        logger.info('Analytics midnight cron registered');
      } catch (jobErr) {
        logger.error('Failed to initialize background analytics jobs', {
          error: (jobErr as Error).message,
        });
      }
    }

  } catch (err) {
    logger.error('Failed to start server', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });

    process.exit(1);
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, shutting down gracefully`);

  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });

  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

// START APP
start();

export { app, httpServer };
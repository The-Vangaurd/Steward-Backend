import 'dotenv/config';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
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

import { startAnalyticsWorker, startAnalyticsCron, startSessionCleanupCron } from './jobs/analytics.job';

// ── Routes ────────────────────────────────────────────────────────────────────
import healthRouter    from './routes/health.routes';
import authRouter      from './routes/auth.routes';
import menuRouter      from './routes/menu.routes';
import orderRouter     from './routes/order.routes';
import analyticsRouter from './routes/analytics.routes';
import staffRouter     from './routes/staff.routes';
import settingsRouter  from './routes/settings.routes';
import themeRouter     from './routes/theme.routes';

const app = express();
app.set('trust proxy', 1); // Trust reverse proxy headers (Render TLS termination)
const httpServer = http.createServer(app);

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      // ── Explicit allowlist from CORS_ORIGINS env var ─────────────────────
      const allowedOrigins = env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map((o) => o.replace(/['"]/g, '').trim())
        : [];
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // ── Dynamic Vercel deployment support ────────────────────────────────
      // Matches all of:
      //   steward-menu.vercel.app            ← bare production deployment
      //   steward-admin-8nma.vercel.app      ← named production deployment
      //   steward-menu-abc123.vercel.app     ← branch preview deployments
      //   steward-admin-abc123.vercel.app    ← branch preview deployments
      const isOwnVercelDeploy =
        /^https:\/\/steward-(admin|menu)(-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
      if (isOwnVercelDeploy) {
        return callback(null, true);
      }

      // Reject everything else cleanly (no thrown errors in server logs)
      callback(null, false);
    },
    credentials: true,
    // Cache preflight for 24 hours to avoid OPTIONS round-trips
    maxAge: 86_400,
  }),
);

app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// ── Request timeout ───────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 30_000;
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        error: { message: 'Request timed out', code: 'REQUEST_TIMEOUT' },
      });
    }
  });
  next();
});

// ── Logging ───────────────────────────────────────────────────────────────────
const morganFormat = env.NODE_ENV === 'production' ? 'short' : 'dev';
app.use(
  morgan(morganFormat, {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.path === '/health',
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(globalRateLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',             healthRouter);
app.use('/v1/auth',            authRouter);
app.use('/v1/menu',            menuRouter);
app.use('/v1/menu',            themeRouter);   // GET /v1/menu/:slug/theme (public)
app.use('/v1/orders',          orderRouter);
app.use('/v1/admin/analytics', analyticsRouter);
app.use('/v1/admin/staff',     staffRouter);
app.use('/v1/settings',        settingsRouter);

// ── 404 & error handlers ──────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const start = async (): Promise<void> => {
  try {
    logger.info('Starting Steward Backend', { env: env.NODE_ENV, port: env.PORT });

    await connectDatabase();
    logger.info('Database connected ✓');

    await new Promise<void>((resolve) => {
      httpServer.listen(env.PORT, '0.0.0.0', () => {
        logger.info(`HTTP server listening on :${env.PORT} [${env.NODE_ENV}]`);
        resolve();
      });
    });

    try {
      await connectRedis();
      logger.info('Redis connected ✓');
    } catch (err) {
      logger.warn('Redis unavailable — continuing without cache/pub-sub', {
        error: (err as Error).message,
      });
    }

    initSocket(httpServer);
    logger.info('Socket.IO initialised ✓');

    if (env.NODE_ENV !== 'test') {
      try {
        startAnalyticsWorker();
        logger.info('Analytics worker started ✓');
        await startAnalyticsCron();
        logger.info('Analytics cron registered ✓');
        await startSessionCleanupCron();
        logger.info('Session cleanup cron registered ✓');
      } catch (jobErr) {
        logger.error('Background job initialisation failed (non-fatal)', {
          error: (jobErr as Error).message,
        });
      }
    }

    logger.info('Steward Backend ready ✓');
  } catch (err) {
    logger.error('Fatal startup error', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal} — shutting down gracefully`);
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});

start();

export { app, httpServer };
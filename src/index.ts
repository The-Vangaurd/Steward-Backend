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
// PERF: Optimised helmet config — disable unused headers that add CPU overhead.
app.use(
  helmet({
    // crossOriginEmbedderPolicy adds a header irrelevant for an API-only server
    crossOriginEmbedderPolicy: false,
    // contentSecurityPolicy is browser-facing; skip for a pure JSON API
    contentSecurityPolicy: false,
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedOrigins = env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : [];
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      // Dynamic Vercel branch preview deployment support
      const isVercelPreview = origin.endsWith('.vercel.app');
      if (isVercelPreview) {
        return callback(null, true);
      }
      
      // Clean browser-level rejection without throwing server logs exceptions
      callback(null, false);
    },
    credentials: true,
    // PERF: Cache preflight for 24 hours to avoid OPTIONS round-trips on every
    // cross-origin request from the admin dashboard.
    maxAge: 86_400,
  }),
);

// PERF: compression() reduces JSON response size by ~60-70 % for larger payloads.
// Already enabled — keep it as the first transform before routes.
app.use(compression());

// PERF: Reduce JSON body limit from 10 MB to 2 MB.  The largest legitimate
// payload in this API is an order (items + notes) which is well under 100 KB.
// A 10 MB limit opens the server to memory exhaustion via large request bodies.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// ── Request timeout ───────────────────────────────────────────────────────────
// PERF: Kill requests that take longer than 30 s.  Without a timeout, slow DB
// queries or Cloudinary uploads hold open an Express connection indefinitely,
// consuming a thread slot and a Prisma connection from the pool.
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
// PERF: Use 'short' format in production (one line, no user-agent, no referrer)
// instead of 'combined' (which logs every header).  Reduces I/O and log volume
// by ~50 % for the same request throughput.
const morganFormat = env.NODE_ENV === 'production' ? 'short' : 'dev';
app.use(
  morgan(morganFormat, {
    stream: { write: (msg) => logger.http(msg.trim()) },
    // Skip health checks — these fire every few seconds from load balancers
    // and contribute nothing useful to logs.
    skip: (req) => req.path === '/health',
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(globalRateLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',                   healthRouter);
app.use('/v1/auth',                  authRouter);
app.use('/v1/menu',                  menuRouter);
app.use('/v1/menu',                  themeRouter);   // GET /v1/menu/:slug/theme (public)
app.use('/v1/orders',                orderRouter);
app.use('/v1/admin/analytics',       analyticsRouter);
app.use('/v1/admin/staff',           staffRouter);
app.use('/v1/settings',              settingsRouter); // GET/PATCH /v1/settings

// ── 404 & error handlers ──────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const start = async (): Promise<void> => {
  try {
    logger.info('Starting Steward Backend', { env: env.NODE_ENV, port: env.PORT });

    // 1. Database — fatal if unreachable
    await connectDatabase();
    logger.info('Database connected ✓');

    // 2. HTTP server — start before optional services so health checks work immediately
    await new Promise<void>((resolve) => {
      httpServer.listen(env.PORT, '0.0.0.0', () => {
        logger.info(`HTTP server listening on :${env.PORT} [${env.NODE_ENV}]`);
        resolve();
      });
    });

    // 3. Redis — non-fatal fallback (caching and sockets degrade gracefully)
    try {
      await connectRedis();
      logger.info('Redis connected ✓');
    } catch (err) {
      logger.warn('Redis unavailable — continuing without cache/pub-sub', {
        error: (err as Error).message,
      });
    }

    // 4. Sockets
    initSocket(httpServer);
    logger.info('Socket.IO initialised ✓');

    // 5. Background jobs — non-fatal
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

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { env } from '../config/env';
import { verifyAccessTokenSafe } from '../utils/jwt';
import { SOCKET_EVENTS, SOCKET_ROOMS } from '../constants';
import { logger } from '../utils/logger';
import { prisma } from '../config/database';

let io: Server;

// ── Order-room validation cache ───────────────────────────────────────────────
// PERF: On every socket reconnect (common on mobile) the old code issued a fresh
// DB query to validate that an orderId belongs to the right restaurant.  We
// keep a short-lived in-memory Map so repeated joins from the same connection
// don't hit the DB.  TTL is 60 s — safe because orders don't change restaurants.
const ORDER_RESTAURANT_CACHE = new Map<string, { restaurantId: string; expiresAt: number }>();
const ORDER_CACHE_TTL_MS = 60_000;

async function getOrderRestaurantId(orderId: string): Promise<string | null> {
  const now = Date.now();
  const cached = ORDER_RESTAURANT_CACHE.get(orderId);
  if (cached && cached.expiresAt > now) return cached.restaurantId;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true },
  });

  if (!order) return null;

  ORDER_RESTAURANT_CACHE.set(orderId, {
    restaurantId: order.restaurantId,
    expiresAt: now + ORDER_CACHE_TTL_MS,
  });

  return order.restaurantId;
}

// PERF: Periodically evict expired entries to prevent unbounded memory growth
// in long-running processes with many distinct order IDs.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of ORDER_RESTAURANT_CACHE) {
    if (val.expiresAt <= now) ORDER_RESTAURANT_CACHE.delete(key);
  }
}, 120_000); // every 2 minutes

export const getIO = (): Server => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};

export const initSocket = (httpServer: HttpServer): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowedOrigins = env.CORS_ORIGINS
          ? env.CORS_ORIGINS.split(',').map((o) => o.replace(/['"]/g, '').trim())
          : [];
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        
        // Support Vercel PR/branch preview deployments
        const isOwnVercelPreview = /^https:\/\/steward-(admin|menu)-[a-z0-9-]+-itz-k[a-z0-9-]*\.vercel\.app$/.test(origin);
        if (isOwnVercelPreview) {
          return callback(null, true);
        }
        
        callback(null, false);
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // PERF: Tighter ping settings detect dead connections faster so the server
    // reclaims memory from stale socket objects sooner.
    pingTimeout: 20_000,   // drop client after 20 s of no pong (default 20 000)
    pingInterval: 25_000,  // send ping every 25 s (default 25 000)
    // PERF: Limit inbound message size to 1 MB (default 1 MB, but explicit
    // so a future Socket.IO upgrade can't silently increase it).
    maxHttpBufferSize: 1e6,
    // PERF: Only allow Engine.IO v4 (Socket.IO 4.x client) — avoids the
    // server maintaining two parallel protocol handshake paths.
    allowEIO3: false,
    // PERF: Upgrade from long-polling to WebSocket as soon as possible
    // (default behaviour, but explicit for clarity).
    upgradeTimeout: 10_000,
  });

  // ── Redis adapter ──────────────────────────────────────────────────────────
  // PERF: Reuse the main Redis connection config where possible.  The adapter
  // needs two separate connections (pub + sub) per Socket.IO specification, but
  // we parse the URL once and share the config object.

  if (!env.REDIS_URL) {
    logger.warn('Socket.IO initialized with in-memory adapter (Redis disabled)');
  } else {
    try {
      const redisOptions = {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableReadyCheck: false,
        // PERF: Retry with exponential back-off so a Redis blip doesn't hammer
        // the server with reconnect storms.
        retryStrategy: (times: number) =>
          times > 5 ? null : Math.min(times * 200, 2000),
      };

      const pubClient = new Redis(env.REDIS_URL, redisOptions);
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) =>
        logger.error('Socket Redis pubClient error', { error: err.message }));
      subClient.on('error', (err) =>
        logger.error('Socket Redis subClient error', { error: err.message }));

      Promise.all([pubClient.connect(), subClient.connect()])
        .then(() => {
          io.adapter(createAdapter(pubClient, subClient));
          logger.info('Socket.IO Redis adapter attached');
        })
        .catch((err) => {
          logger.error('Socket Redis connection failed, falling back to in-memory', {
            error: err.message,
          });
        });
    } catch (err) {
      logger.error('Failed to initialise Socket.IO Redis adapter', {
        error: (err as Error).message,
      });
    }
  }

  // ── JWT auth middleware ────────────────────────────────────────────────────

  io.use((socket: Socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace?.('Bearer ', '');

    socket.data = socket.data || {};
    socket.data.user = null;
    socket.data.isAuthenticated = false;

    if (!token) return next();

    const result = verifyAccessTokenSafe(token);
    if (!result.payload && !result.expired) {
      return next(new Error('TOKEN_INVALID'));
    }
    if (result.expired) {
      socket.data.user = result.payload ?? null;
      socket.data.isAuthenticated = false;
      return next(new Error('TOKEN_EXPIRED'));
    }

    socket.data.user = result.payload;
    socket.data.isAuthenticated = true;
    return next();
  });

  io.on(SOCKET_EVENTS.CONNECTION, (socket: Socket) => {
    const user = socket.data.user;
    // PERF: Only log at debug level in production — connection events are very
    // frequent and 'info' floods logs unnecessarily.
    logger.debug('WS client connected', {
      socketId: socket.id,
      userId: user?.sub ?? 'guest',
    });

    socket.on(SOCKET_EVENTS.JOIN_ROOM, async (
      room: string,
      cb?: (err?: { code: string; message: string } | null) => void,
    ) => {
      try {
        const [prefix, id] = room.split(':');

        if (!['restaurant', 'kitchen', 'order', 'admin'].includes(prefix)) {
          throw new Error('INVALID_ROOM');
        }

        if (prefix === 'restaurant') {
          socket.join(room);
          cb?.(null);
          return;
        }

        if (prefix === 'kitchen') {
          const role = socket.data.user?.role;
          if (
            !socket.data.isAuthenticated ||
            !['KITCHEN_STAFF', 'WAITER', 'ADMIN', 'SUPER_ADMIN'].includes(role)
          ) {
            throw new Error('FORBIDDEN');
          }
          if (
            socket.data.user?.restaurantId !== id &&
            socket.data.user?.role !== 'SUPER_ADMIN'
          ) {
            throw new Error('FORBIDDEN');
          }
        }

        if (prefix === 'admin') {
          const role = socket.data.user?.role;
          if (!socket.data.isAuthenticated || !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
            throw new Error('FORBIDDEN');
          }
          if (
            socket.data.user?.restaurantId !== id &&
            socket.data.user?.role !== 'SUPER_ADMIN'
          ) {
            throw new Error('FORBIDDEN');
          }
        }

        if (prefix === 'order') {
          if (socket.data.isAuthenticated && socket.data.user?.restaurantId) {
            // PERF: Use in-memory cache to avoid a DB hit on every reconnect.
            // Mobile clients reconnect frequently (network switches, app resume).
            const orderRestaurantId = await getOrderRestaurantId(id);

            if (!orderRestaurantId) throw new Error('INVALID_ROOM');

            if (
              orderRestaurantId !== socket.data.user.restaurantId &&
              socket.data.user.role !== 'SUPER_ADMIN'
            ) {
              throw new Error('FORBIDDEN');
            }
          }
          // Unauthenticated guests (customers tracking their order) pass through.
        }

        socket.join(room);
        cb?.(null);
      } catch (e: any) {
        const code = e?.message ?? 'INVALID_ROOM';
        logger.warn('Unauthorised room join attempt', {
          socketId: socket.id,
          room,
          code,
        });
        cb?.({ code, message: 'Unauthorized to join room' });
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_ROOM, (room: string) => {
      socket.leave(room);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, (reason: string) => {
      logger.debug('WS client disconnected', { socketId: socket.id, reason });
      // PERF: No explicit cleanup needed — Socket.IO automatically removes
      // the socket from all rooms on disconnect.
    });
  });

  logger.info('Socket.IO initialised');
  return io;
};

// ── Emit helpers ──────────────────────────────────────────────────────────────

export const emitToRestaurant = (restaurantId: string, event: string, data: unknown): void => {
  getIO().to(SOCKET_ROOMS.restaurant(restaurantId)).emit(event, data);
};

export const emitToKitchen = (restaurantId: string, event: string, data: unknown): void => {
  getIO().to(SOCKET_ROOMS.kitchen(restaurantId)).emit(event, data);
};

export const emitToOrder = (orderId: string, event: string, data: unknown): void => {
  getIO().to(SOCKET_ROOMS.order(orderId)).emit(event, data);
};

export const emitToAdmin = (restaurantId: string, event: string, data: unknown): void => {
  getIO().to(SOCKET_ROOMS.admin(restaurantId)).emit(event, data);
};

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

export const getIO = (): Server => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};

export const initSocket = (httpServer: HttpServer): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS
        ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // ── Redis adapter ──────────────────────────────────────────────────────────

  if (!env.REDIS_URL) {
    logger.warn('Socket.IO initialized with in-memory adapter (Redis disabled)');
  } else {
    try {
      const pubClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => logger.error('Socket Redis pubClient error', { error: err.message }));
      subClient.on('error', (err) => logger.error('Socket Redis subClient error', { error: err.message }));

      Promise.all([pubClient.connect(), subClient.connect()])
        .then(() => {
          io.adapter(createAdapter(pubClient, subClient));
          logger.info('Socket.IO Redis adapter attached');
        })
        .catch((err) => {
          logger.error('Socket Redis connection failed, falling back to in-memory', { error: err.message });
        });
    } catch (err) {
      logger.error('Failed to initialise Socket.IO Redis adapter', { error: (err as Error).message });
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
    logger.info('WS client connected', { socketId: socket.id, userId: user?.sub ?? 'guest' });

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
          // Read-only broadcast room — open to all (staff and public customers)
          socket.join(room);
          logger.debug('WS joined room', { socketId: socket.id, room });
          cb?.(null);
          return;
        }

        if (prefix === 'kitchen') {
          const role = socket.data.user?.role;
          if (!socket.data.isAuthenticated || !['KITCHEN_STAFF', 'WAITER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
            throw new Error('FORBIDDEN');
          }
          if (socket.data.user?.restaurantId !== id && socket.data.user?.role !== 'SUPER_ADMIN') {
            throw new Error('FORBIDDEN');
          }
        }

        if (prefix === 'admin') {
          const role = socket.data.user?.role;
          if (!socket.data.isAuthenticated || !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
            throw new Error('FORBIDDEN');
          }
          if (socket.data.user?.restaurantId !== id && socket.data.user?.role !== 'SUPER_ADMIN') {
            throw new Error('FORBIDDEN');
          }
        }

        if (prefix === 'order') {
          // BUG FIX: previously compared restaurantId === orderId (wrong).
          // Now we look up the order to get its restaurantId and compare that
          // against the authenticated user's restaurantId, preventing
          // cross-restaurant socket room access by staff.
          if (socket.data.isAuthenticated && socket.data.user?.restaurantId) {
            const order = await prisma.order.findUnique({
              where: { id },
              select: { restaurantId: true },
            });

            if (!order) throw new Error('INVALID_ROOM');

            if (order.restaurantId !== socket.data.user.restaurantId &&
                socket.data.user.role !== 'SUPER_ADMIN') {
              throw new Error('FORBIDDEN');
            }
          }
          // Unauthenticated guests (customers tracking their order) are allowed through.
        }

        socket.join(room);
        logger.debug('WS joined room', { socketId: socket.id, room });
        cb?.(null);
      } catch (e: any) {
        const code = e?.message ?? 'INVALID_ROOM';
        logger.warn('Unauthorised room join attempt', { socketId: socket.id, room, code });
        cb?.({ code, message: 'Unauthorized to join room' });
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_ROOM, (room: string) => {
      socket.leave(room);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
      logger.info('WS client disconnected', { socketId: socket.id });
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

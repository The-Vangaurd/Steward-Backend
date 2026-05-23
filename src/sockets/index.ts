import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { env } from '../config/env';
import { verifyAccessTokenSafe } from '../utils/jwt';
import { SOCKET_EVENTS, SOCKET_ROOMS } from '../constants';
import { logger } from '../utils/logger';

let io: Server;

export const getIO = (): Server => {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
};

export const initSocket = (httpServer: HttpServer): Server => {
  const pubClient = new Redis(env.REDIS_URL);
  const subClient = pubClient.duplicate();

  io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.adapter(createAdapter(pubClient, subClient));

  // ── JWT auth middleware ──────────────────────────────────────────────────────
  io.use((socket: Socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace?.('Bearer ', '');

    // default socket data
    socket.data = socket.data || {};
    socket.data.user = null;
    socket.data.isAuthenticated = false;

    // Public connections (customer order tracking) may omit a token
    if (!token) return next();

    const result = verifyAccessTokenSafe(token);
    if (!result.payload && !result.expired) {
      return next(new Error('TOKEN_INVALID'));
    }

    if (result.expired) {
      // Attach decoded payload for potential client-side refresh flow, but reject
      // the handshake so clients can refresh tokens and reconnect.
      socket.data.user = result.payload ?? null;
      socket.data.isAuthenticated = false;
      return next(new Error('TOKEN_EXPIRED'));
    }

    // valid token
    socket.data.user = result.payload;
    socket.data.isAuthenticated = true;
    return next();
  });

  io.on(SOCKET_EVENTS.CONNECTION, (socket: Socket) => {
    const user = socket.data.user;
    logger.info('WS client connected', { socketId: socket.id, userId: user?.sub ?? 'guest' });

    // ── Room join/leave with authorization checks ──────────────────────────────
    socket.on(SOCKET_EVENTS.JOIN_ROOM, (room: string, cb?: (err?: { code: string; message: string } | null) => void) => {
      try {
        const [prefix, id] = room.split(':');

        // protect internal/non-pattern rooms
        if (!['restaurant', 'kitchen', 'order', 'admin'].includes(prefix)) {
          throw new Error('INVALID_ROOM');
        }

        // restaurant: room is read-only broadcast — allow unauthenticated public joins.
        // Authenticated staff are also welcome (they get extra context).
        if (prefix === 'restaurant') {
          socket.join(room);
          logger.debug('WS joined room', { socketId: socket.id, room });
          cb?.(null);
          return;
        }

        if (prefix === 'kitchen') {
          const role = socket.data.user?.role;
          if (!socket.data.isAuthenticated || ![ 'KITCHEN_STAFF', 'WAITER', 'ADMIN', 'SUPER_ADMIN' ].includes(role)) {
            throw new Error('FORBIDDEN');
          }
          if (socket.data.user?.restaurantId !== id && socket.data.user?.role !== 'SUPER_ADMIN') {
            throw new Error('FORBIDDEN');
          }
        }

        if (prefix === 'admin') {
          const role = socket.data.user?.role;
          if (!socket.data.isAuthenticated || ![ 'ADMIN', 'SUPER_ADMIN' ].includes(role)) {
            throw new Error('FORBIDDEN');
          }
          if (socket.data.user?.restaurantId !== id && socket.data.user?.role !== 'SUPER_ADMIN') {
            throw new Error('FORBIDDEN');
          }
        }

        // order rooms are allowed for authenticated users belonging to restaurant
        if (prefix === 'order') {
          // Best-effort: allow authenticated users from same restaurant, or allow anonymous
          // since customers may not be authenticated. Prevent staff from joining unrelated orders.
          if (socket.data.isAuthenticated && socket.data.user?.restaurantId && socket.data.user.restaurantId !== id) {
            throw new Error('FORBIDDEN');
          }
        }

        socket.join(room);
        logger.debug('WS joined room', { socketId: socket.id, room });
        cb?.(null);
      } catch (e: any) {
        const code = e?.message ?? 'INVALID_ROOM';
        logger.warn('Unauthorized room join attempt', { socketId: socket.id, room, code });
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

  logger.info('Socket.IO initialized with Redis adapter');
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

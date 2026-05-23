import { ORDER_STATUS_TRANSITIONS } from '../utils/stateMachine';

// ─── HTTP Status Codes ────────────────────────────────────────────────────────

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

// ─── Error Codes ──────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Resources
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // Orders
  ORDER_STATUS_INVALID_TRANSITION: 'ORDER_STATUS_INVALID_TRANSITION',
  ORDER_ITEM_UNAVAILABLE: 'ORDER_ITEM_UNAVAILABLE',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

// ─── Order Status Flow ────────────────────────────────────────────────────────

export { ORDER_STATUS_TRANSITIONS };

// ─── Socket Events ────────────────────────────────────────────────────────────

export const SOCKET_EVENTS = {
  // Order lifecycle
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_STATUS_CHANGED: 'order:status_changed',
  ORDER_CANCELLED: 'order:cancelled',

  // Kitchen
  KITCHEN_NEW_ORDER: 'kitchen:new_order',
  KITCHEN_ORDER_READY: 'kitchen:order_ready',

  // Connection
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  ITEM_AVAILABILITY_CHANGED: 'item:availability_changed',
} as const;

export const SOCKET_ROOMS = {
  restaurant: (id: string) => `restaurant:${id}`,
  kitchen: (id: string) => `kitchen:${id}`,
  order: (id: string) => `order:${id}`,
  admin: (id: string) => `admin:${id}`,
} as const;

// ─── Cache Keys ───────────────────────────────────────────────────────────────

export const CACHE_KEYS = {
  menu: (restaurantId: string) => `menu:${restaurantId}`,
  menuItem: (id: string) => `menu_item:${id}`,
  categories: (restaurantId: string) => `categories:${restaurantId}`,
  restaurant: (id: string) => `restaurant:${id}`,
  order: (id: string) => `order:${id}`,
  analytics: (restaurantId: string, date: string) =>
    `analytics:${restaurantId}:${date}`,
} as const;

export const CACHE_TTL = {
  MENU: 300,          // 5 minutes
  CATEGORIES: 600,    // 10 minutes
  RESTAURANT: 3600,   // 1 hour
  ORDER: 60,          // 1 minute
  ANALYTICS: 1800,    // 30 minutes
} as const;
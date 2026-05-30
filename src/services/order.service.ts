import { prisma } from '../config/database';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { generateOrderNumber } from '../utils/orderNumber';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL, SOCKET_EVENTS } from '../constants';
import { ApiError } from '../utils/ApiError';
import { emitToKitchen, emitToOrder, emitToAdmin, emitToRestaurant } from '../sockets';
import { CreateOrderInput, UpdateOrderStatusInput, OrderQuery } from '../validators/order.validator';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';
import { OrderStatus } from '@prisma/client';
import {
  getAllowedOrderStatusTransitions,
  isValidOrderStatusTransition,
  validateUndoTransition,
} from '../utils/stateMachine';

// ── Minimal select shapes ─────────────────────────────────────────────────────

/**
 * Fields needed by the kitchen kanban board.
 * Includes startedPreparingAt so the frontend timer works locally.
 */
const KITCHEN_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  orderType: true,
  tableNumber: true,
  notes: true,
  estimatedMins: true,
  createdAt: true,
  startedPreparingAt: true,
  items: {
    select: {
      id: true,
      name: true,
      quantity: true,
      notes: true,
      menuItem: { select: { kitchenType: true } },
    },
  },
} as const;

const ORDER_WITH_HISTORY_SELECT = {
  id: true,
  orderNumber: true,
  restaurantId: true,
  guestId: true,
  status: true,
  orderType: true,
  tableNumber: true,
  customerName: true,
  customerPhone: true,
  notes: true,
  subtotal: true,
  taxAmount: true,
  serviceChargeAmount: true,
  totalAmount: true,
  estimatedMins: true,
  startedPreparingAt: true,
  readyAt: true,
  completedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      name: true,
      price: true,
      quantity: true,
      subtotal: true,
      notes: true,
    },
  },
  statusHistory: {
    orderBy: { createdAt: 'asc' as const },
    select: { status: true, note: true, createdAt: true },
  },
} as const;

const GUEST_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  restaurantId: true,
  status: true,
  orderType: true,
  tableNumber: true,
  notes: true,
  subtotal: true,
  taxAmount: true,
  serviceChargeAmount: true,
  totalAmount: true,
  estimatedMins: true,
  startedPreparingAt: true,
  readyAt: true,
  completedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      name: true,
      price: true,
      quantity: true,
      subtotal: true,
      notes: true,
    },
  },
  statusHistory: {
    orderBy: { createdAt: 'asc' as const },
    select: { status: true, note: true, createdAt: true },
  },
} as const;

export const orderService = {
  async createOrder(slugOrId: string, input: CreateOrderInput) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: {
        id: true,
        timezone: true,
        settings: {
          select: {
            taxRate: true,
            serviceCharge: true,
            autoAcceptOrders: true,
            offlineMode: true,
            offlineModeMessage: true,
            openingHours: true,
            estimatedPrepMins: true,
          },
        },
      },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const settings = restaurant.settings;

    // 1. Enforce offline mode
    if (settings?.offlineMode) {
      throw ApiError.badRequest(
        settings.offlineModeMessage ?? 'Restaurant is currently closed.',
        'OFFLINE_MODE'
      );
    }

    // 2. Enforce opening hours
    if (settings?.openingHours) {
      const now = new Date();
      const tz = restaurant.timezone ?? "Asia/Kolkata";
      
      // Calculate day number (0-6) relative to the restaurant's timezone
      const tzDateString = now.toLocaleString("en-US", { timeZone: tz });
      const tzDate = new Date(tzDateString);
      const dayNum = tzDate.getDay();

      const hours = settings.openingHours as Array<{ day: number; open: string; close: string; closed: boolean }> | null;
      if (hours && Array.isArray(hours)) {
        const todayHours = hours.find((h) => h.day === dayNum);
        if (todayHours?.closed) {
          throw ApiError.badRequest("The restaurant is closed today.", "STORE_CLOSED");
        }
        if (todayHours) {
          const localTime = new Intl.DateTimeFormat("en-GB", {
            timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
          }).format(now);
          if (localTime < todayHours.open || localTime >= todayHours.close) {
            throw ApiError.badRequest(
              `We're only open ${todayHours.open}–${todayHours.close} today.`,
              "STORE_CLOSED"
            );
          }
        }
      }
    }

    const restaurantId = restaurant.id;
    const taxRate = restaurant.settings
      ? Number(restaurant.settings.taxRate)
      : 0.05;
    const serviceChargeRate = restaurant.settings
      ? Number(restaurant.settings.serviceCharge)
      : 0.00;

    const menuItemIds = input.items.map((i) => i.menuItemId);
    const uniqueMenuItemIds = Array.from(new Set(menuItemIds));
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: uniqueMenuItemIds }, category: { restaurantId } },
      select: {
        id: true,
        name: true,
        price: true,
        isAvailable: true,
        prepTimeMins: true,
      },
    });

    if (menuItems.length !== uniqueMenuItemIds.length) {
      throw ApiError.badRequest(
        'One or more menu items are invalid or unavailable for this restaurant',
        'INVALID_MENU_ITEMS',
      );
    }

    const unavailable = menuItems.filter((m) => !m.isAvailable);
    if (unavailable.length > 0) {
      throw ApiError.badRequest(
        `Items unavailable: ${unavailable.map((m) => m.name).join(', ')}`,
        'ORDER_ITEM_UNAVAILABLE',
      );
    }

    const itemMap = new Map(menuItems.map((m) => [m.id, m]));
    const orderItems = input.items.map((i) => {
      const mi = itemMap.get(i.menuItemId)!;
      return {
        menuItemId: i.menuItemId,
        name: mi.name,
        price: mi.price,
        quantity: i.quantity,
        subtotal: Number(mi.price) * i.quantity,
        notes: i.notes,
      };
    });

    const subtotal = orderItems.reduce((sum, i) => sum + i.subtotal, 0);
    if (subtotal <= 0) {
      throw ApiError.badRequest('Order total must be greater than zero', 'ORDER_TOTAL_ZERO');
    }
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
    const serviceChargeAmount = Math.round(subtotal * serviceChargeRate * 100) / 100;
    const totalAmount = subtotal + taxAmount + serviceChargeAmount;

    const maxPrep = Math.max(...menuItems.map((m) => m.prepTimeMins));
    const orderNumber = await generateOrderNumber(restaurantId);

    let [order] = await prisma.$transaction([
      prisma.order.create({
        data: {
          orderNumber,
          restaurantId,
          status: OrderStatus.NEW,
          orderType: input.orderType,
          tableNumber: input.tableNumber,
          notes: input.notes,
          deliveryAddress: input.deliveryAddress,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: input.customerEmail,
          subtotal,
          taxAmount,
          serviceChargeAmount,
          totalAmount,
          estimatedMins: maxPrep + 5,
          guestId: input.guestId || null,
          items: { create: orderItems },
          statusHistory: {
            create: { status: OrderStatus.NEW, note: 'Order placed' },
          },
        },
        select: ORDER_WITH_HISTORY_SELECT,
      }),
    ]);

    await cacheDel(CACHE_KEYS.kitchenOrders(restaurantId));

    // Broadcaster: Emit to clean socket events and legacy events
    // Send full populated order object to eliminate client roundtrip calls
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_CREATED, order); // 'order_created'
    emitToKitchen(restaurantId, SOCKET_EVENTS.KITCHEN_NEW_ORDER, order); // legacy 'kitchen:new_order'
    emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_CREATED_LEGACY, order); // legacy 'order:created'

    // S3-B: Handle autoAcceptOrders setting
    const autoAccept = restaurant.settings?.autoAcceptOrders ?? false;
    if (autoAccept) {
      order = await this.updateOrderStatus(order.id, restaurantId, {
        status: OrderStatus.PREPARING,
        note: 'Order accepted automatically',
      });
    }

    let recallToken: string | undefined;
    if (order.guestId) {
      recallToken = jwt.sign(
        { orderId: order.id, guestId: order.guestId, restaurantSlug: slugOrId },
        env.JWT_GUEST_SECRET,
        { expiresIn: '30d' }
      );
    }

    return { ...order, recallToken, estimatedPrepMins: restaurant.settings?.estimatedPrepMins ?? 20 };
  },

  async getOrderById(id: string) {
    const cacheKey = CACHE_KEYS.order(id);
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    const order = await prisma.order.findUnique({
      where: { id },
      select: ORDER_WITH_HISTORY_SELECT,
    });

    if (!order) throw ApiError.notFound('Order not found');
    await cacheSet(cacheKey, order, CACHE_TTL.ORDER);
    return order;
  },

  async getOrderTracking(id: string) {
    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        estimatedMins: true,
        createdAt: true,
        startedPreparingAt: true,
        readyAt: true,
        completedAt: true,
        cancelledAt: true,
        guestId: true,
        items: {
          select: {
            id: true,
            name: true,
            price: true,
            quantity: true,
            notes: true,
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: { status: true, note: true, createdAt: true },
        },
      },
    });

    if (!order) throw ApiError.notFound('Order not found');
    return order;
  },

  async updateOrderStatus(
    orderId: string,
    restaurantId: string,
    input: UpdateOrderStatusInput,
  ) {
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, restaurantId: true },
      });
      if (!order || order.restaurantId !== restaurantId) {
        throw ApiError.notFound('Order not found');
      }

      const allowed = getAllowedOrderStatusTransitions(order.status);
      if (!isValidOrderStatusTransition(order.status, input.status)) {
        throw ApiError.badRequest(
          `Transition from ${order.status} to ${input.status} is not allowed. Valid transitions are: ${allowed.join(', ')}`,
          'ORDER_STATUS_INVALID_TRANSITION',
        );
      }

      // Timestamp each transition
      const timestamps: Record<string, Date> = {};
      if (input.status === OrderStatus.PREPARING)  timestamps.startedPreparingAt = new Date();
      if (input.status === OrderStatus.READY)      timestamps.readyAt            = new Date();
      if (input.status === OrderStatus.COMPLETED)  timestamps.completedAt        = new Date();
      if (input.status === OrderStatus.CANCELLED)  timestamps.cancelledAt        = new Date();

      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: input.status, ...timestamps },
      });

      if (updateResult.count !== 1) {
        throw ApiError.conflict(
          'Order status was modified concurrently. Retry the operation.',
          'ORDER_STATUS_CONFLICT',
        );
      }

      await tx.orderStatusHistory.create({
        data: { orderId, status: input.status, note: input.note },
      });

      const refreshed = await tx.order.findUnique({
        where: { id: orderId },
        select: ORDER_WITH_HISTORY_SELECT,
      });

      if (!refreshed) throw ApiError.notFound('Order not found after update');
      return refreshed;
    });

    await Promise.all([
      cacheDel(CACHE_KEYS.order(orderId)),
      cacheDel(CACHE_KEYS.kitchenOrders(restaurantId)),
    ]);

    // Broadcaster: emit full 'updated' order object to all listeners
    
    // 1. Specific Order tracking room
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_UPDATED, updated); // clean 'order_updated'
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_UPDATED_LEGACY, updated); // legacy 'order:updated'
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_STATUS_CHANGED, { // legacy status changed payload
      orderId,
      status: input.status,
      timestamp: new Date(),
    });

    // 2. Kitchen / Restaurant / Admin rooms
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated); // clean 'order_updated'
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED_LEGACY, updated); // legacy 'order:updated'
    emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);
    emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);

    // 3. Status-specific events
    if (input.status === OrderStatus.COMPLETED) {
      emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_COMPLETED, updated);
      emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_COMPLETED, updated);
      emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_COMPLETED, updated);
      emitToOrder(orderId, SOCKET_EVENTS.ORDER_COMPLETED, updated);
    }
    
    if (input.status === OrderStatus.CANCELLED) {
      emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_CANCELLED, updated);
      emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_CANCELLED, updated);
      emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_CANCELLED, updated);
      emitToOrder(orderId, SOCKET_EVENTS.ORDER_CANCELLED, updated);
    }

    if (input.status === OrderStatus.READY) {
      emitToOrder(orderId, SOCKET_EVENTS.KITCHEN_ORDER_READY, { orderId });
    }

    return updated;
  },

  async undoOrderStatus(orderId: string, restaurantId: string, note?: string) {
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, restaurantId: true },
      });
      if (!order || order.restaurantId !== restaurantId) {
        throw ApiError.notFound('Order not found');
      }

      let prevStatus: OrderStatus;
      try {
        prevStatus = validateUndoTransition(order.status);
      } catch (err) {
        throw ApiError.badRequest((err as Error).message, 'ORDER_STATUS_UNDO_NOT_ALLOWED');
      }

      // Clear the timestamp when rolling back
      const clearTimestamps: Record<string, null> = {};
      if (order.status === OrderStatus.PREPARING) clearTimestamps.startedPreparingAt = null;
      if (order.status === OrderStatus.READY)     clearTimestamps.readyAt = null;

      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: prevStatus, ...clearTimestamps },
      });

      if (updateResult.count !== 1) {
        throw ApiError.conflict(
          'Order status was modified concurrently. Retry the operation.',
          'ORDER_STATUS_CONFLICT',
        );
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: prevStatus,
          note: note ?? `Reverted from ${order.status} (kitchen undo)`,
        },
      });

      const refreshed = await tx.order.findUnique({
        where: { id: orderId },
        select: ORDER_WITH_HISTORY_SELECT,
      });
      if (!refreshed) throw ApiError.notFound('Order not found after undo');
      return refreshed;
    });

    await Promise.all([
      cacheDel(CACHE_KEYS.order(orderId)),
      cacheDel(CACHE_KEYS.kitchenOrders(restaurantId)),
    ]);

    // Broadcaster: Broadcast full reverted order to sync all devices instantly
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated); // clean 'order_updated'
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED_LEGACY, updated); // legacy 'order:updated'
    emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);
    emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_UPDATED, updated);

    return updated;
  },

  // ── Kitchen queue ─────────────────────────────────────────────────────────

  async getKitchenOrders(restaurantId: string) {
    const cacheKey = CACHE_KEYS.kitchenOrders(restaurantId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Only show active states on the kanban board
    const activeStatuses = [
      OrderStatus.NEW,
      OrderStatus.PREPARING,
      OrderStatus.READY,
    ];

    const orders = await prisma.order.findMany({
      where: { restaurantId, status: { in: activeStatuses } },
      select: KITCHEN_ORDER_SELECT,
      orderBy: { createdAt: 'asc' },
    });

    await cacheSet(cacheKey, orders, CACHE_TTL.KITCHEN_ORDERS);
    return orders;
  },

  // ── Admin order listing ───────────────────────────────────────────────────

  async getAdminOrders(restaurantId: string, query: OrderQuery) {
    const pagination = parsePagination(query.page, query.limit);

    const where: Record<string, unknown> = { restaurantId };
    if (query.status) {
      where.status = Array.isArray(query.status)
        ? { in: query.status }
        : query.status;
    }
    if (query.orderType) where.orderType = query.orderType;
    if (query.from || query.to) {
      const createdAt: { gte?: Date; lte?: Date } = {};
      if (query.from) createdAt.gte = new Date(query.from as string);
      if (query.to)   createdAt.lte = new Date(query.to as string);
      where.createdAt = createdAt;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          orderType: true,
          tableNumber: true,
          customerName: true,
          customerPhone: true,
          subtotal: true,
          taxAmount: true,
          serviceChargeAmount: true,
          totalAmount: true,
          estimatedMins: true,
          createdAt: true,
          updatedAt: true,
          items: { select: { name: true, quantity: true, price: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, meta: buildPaginationMeta(total, pagination.page, pagination.limit) };
  },

  async getGuestOrders(guestId: string, restaurantSlug: string) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: restaurantSlug }
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    return prisma.order.findMany({
      where: {
        guestId,
        restaurantId: restaurant.id
      },
      select: GUEST_ORDER_SELECT,
      orderBy: { createdAt: 'desc' }
    });
  },

  async cancelGuestOrder(orderId: string, guestId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, guestId: true, restaurantId: true }
    });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.guestId !== guestId) {
      throw ApiError.forbidden('You do not have permission to cancel this order', 'ORDER_CANCEL_FORBIDDEN');
    }
    if (order.status !== OrderStatus.NEW) {
      throw ApiError.badRequest('Only NEW orders can be cancelled', 'ORDER_CANCEL_INVALID_STATUS');
    }

    return this.updateOrderStatus(orderId, order.restaurantId, {
      status: OrderStatus.CANCELLED,
      note: 'Cancelled by guest'
    });
  },

  async lookupOrder(orderNumber: string, restaurantSlug: string, customerPhoneSuffix: string) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug: restaurantSlug }
    });
    if (!restaurant) throw ApiError.notFound('Order not found or details mismatch');

    const order = await prisma.order.findFirst({
      where: {
        orderNumber: orderNumber.trim().toUpperCase(),
        restaurantId: restaurant.id,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        customerPhone: true,
      },
    });

    if (!order) throw ApiError.notFound('Order not found or details mismatch');

    // Verify phone suffix if the order has a phone number
    if (!order.customerPhone || !order.customerPhone.endsWith(customerPhoneSuffix)) {
        throw ApiError.notFound('Order not found or details mismatch');
    }

    return {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt
    };
  },
};

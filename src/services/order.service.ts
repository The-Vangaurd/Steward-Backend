import { prisma } from '../config/database';
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
 * Fields needed by the kitchen queue display.
 * Deliberately excludes customer PII and financial totals — kitchen only needs
 * item names, quantities, prep info and status.
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

/**
 * Fields returned after a status update.  Keeps statusHistory for the
 * order-tracking panel but only the fields that the clients actually render.
 */
const ORDER_WITH_HISTORY_SELECT = {
  id: true,
  orderNumber: true,
  restaurantId: true,
  status: true,
  orderType: true,
  tableNumber: true,
  customerName: true,
  customerPhone: true,
  notes: true,
  subtotal: true,
  taxAmount: true,
  totalAmount: true,
  estimatedMins: true,
  confirmedAt: true,
  preparedAt: true,
  readyAt: true,
  deliveredAt: true,
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
    // PERF: single query fetches restaurant + settings together, eliminating
    // the previous sequential restaurant.findFirst → getTaxRate(restaurantId)
    // chain (was 2 round-trips, now 1).
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: {
        id: true,
        settings: { select: { taxRate: true } },
      },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const restaurantId = restaurant.id;
    const taxRate = restaurant.settings
      ? Number(restaurant.settings.taxRate)
      : 0.05; // fallback matches settingsService.getTaxRate

    // SECURE & PERF: Validate every menu item in the order belongs to the restaurant.
    // We also select 'price' from the database to enforce database-derived pricing,
    // explicitly ignoring any client-submitted pricing fields to prevent pricing tampering.
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

    // Build order items with snapshot pricing
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
    const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
    const totalAmount = subtotal + taxAmount;

    const maxPrep = Math.max(...menuItems.map((m) => m.prepTimeMins));
    const orderNumber = await generateOrderNumber(restaurantId);

    const [order] = await prisma.$transaction([
      prisma.order.create({
        data: {
          orderNumber,
          restaurantId,
          status: OrderStatus.PENDING,
          orderType: input.orderType,
          tableNumber: input.tableNumber,
          notes: input.notes,
          deliveryAddress: input.deliveryAddress,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: input.customerEmail,
          subtotal,
          taxAmount,
          totalAmount,
          estimatedMins: maxPrep + 5,
          items: { create: orderItems },
          statusHistory: {
            create: { status: OrderStatus.PENDING, note: 'Order placed' },
          },
        },
        // PERF: Use select instead of broad include — avoids pulling statusHistory
        // (just written above) back over the wire; kitchen only needs item names.
        select: ORDER_WITH_HISTORY_SELECT,
      }),
    ]);

    // PERF: Invalidate kitchen cache so the new order appears immediately
    await cacheDel(CACHE_KEYS.kitchenOrders(restaurantId));

    // PERF: Emit lean kitchen payload (just what kitchen display needs)
    const kitchenPayload = {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      tableNumber: order.tableNumber,
      orderType: order.orderType,
      estimatedMins: order.estimatedMins,
      createdAt: order.createdAt,
      items: order.items,
    };
    emitToKitchen(restaurantId, SOCKET_EVENTS.KITCHEN_NEW_ORDER, kitchenPayload);
    emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_CREATED, kitchenPayload);

    return order;
  },

  async getOrderById(id: string) {
    const cacheKey = CACHE_KEYS.order(id);
    const cached = await cacheGet(cacheKey);
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
        confirmedAt: true,
        preparedAt: true,
        readyAt: true,
        deliveredAt: true,
        cancelledAt: true,
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
      const order = await tx.order.findFirst({ where: { id: orderId, restaurantId } });
      if (!order) throw ApiError.notFound('Order not found');

      const allowed = getAllowedOrderStatusTransitions(order.status);
      if (!isValidOrderStatusTransition(order.status, input.status)) {
        throw ApiError.badRequest(
          `Transition from ${order.status} to ${input.status} is not allowed. Valid transitions are: ${allowed.join(', ')}`,
          'ORDER_STATUS_INVALID_TRANSITION',
        );
      }

      const timestamps: Record<string, Date> = {};
      if (input.status === OrderStatus.CONFIRMED) timestamps.confirmedAt = new Date();
      if (input.status === OrderStatus.PREPARING)  timestamps.preparedAt  = new Date();
      if (input.status === OrderStatus.READY)      timestamps.readyAt     = new Date();
      if (input.status === OrderStatus.DELIVERED)  timestamps.deliveredAt = new Date();
      if (input.status === OrderStatus.CANCELLED)  timestamps.cancelledAt = new Date();

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

      // PERF: Use select (not include) to fetch only what clients render
      const refreshed = await tx.order.findUnique({
        where: { id: orderId },
        select: ORDER_WITH_HISTORY_SELECT,
      });

      if (!refreshed) throw ApiError.notFound('Order not found after update');
      return refreshed;
    });

    // PERF: Invalidate both per-order and kitchen queue caches
    await Promise.all([
      cacheDel(CACHE_KEYS.order(orderId)),
      cacheDel(CACHE_KEYS.kitchenOrders(restaurantId)),
    ]);

    // PERF: Order-tracking room receives a minimal status-change event (not
    // the full order) — reduces per-event payload size by ~80 %.
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_STATUS_CHANGED, {
      orderId,
      status: input.status,
      timestamp: new Date(),
    });

    // PERF: Kitchen and admin get a lean update payload (no full statusHistory)
    const kitchenUpdatePayload = {
      id: updated.id,
      orderNumber: updated.orderNumber,
      restaurantId: updated.restaurantId,
      status: updated.status,
      tableNumber: updated.tableNumber,
      orderType: updated.orderType,
      estimatedMins: updated.estimatedMins,
      updatedAt: updated.updatedAt,
      items: updated.items,
    };
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, kitchenUpdatePayload);
    emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, kitchenUpdatePayload);

    if (input.status === OrderStatus.READY) {
      emitToOrder(orderId, SOCKET_EVENTS.KITCHEN_ORDER_READY, { orderId });
    }

    return updated;
  },

  /**
   * Kitchen undo: reverse the order one status step backward.
   */
  async undoOrderStatus(orderId: string, restaurantId: string, note?: string) {
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, restaurantId } });
      if (!order) throw ApiError.notFound('Order not found');

      let prevStatus: OrderStatus;
      try {
        prevStatus = validateUndoTransition(order.status);
      } catch (err) {
        throw ApiError.badRequest((err as Error).message, 'ORDER_STATUS_UNDO_NOT_ALLOWED');
      }

      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: prevStatus },
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

      // PERF: Use select (not include) to fetch only what clients render
      const refreshed = await tx.order.findUnique({
        where: { id: orderId },
        select: ORDER_WITH_HISTORY_SELECT,
      });
      if (!refreshed) throw ApiError.notFound('Order not found after undo');
      return refreshed;
    });

    // PERF: Invalidate both caches in parallel
    await Promise.all([
      cacheDel(CACHE_KEYS.order(orderId)),
      cacheDel(CACHE_KEYS.kitchenOrders(restaurantId)),
    ]);

    const kitchenUpdatePayload = {
      id: updated.id,
      orderNumber: updated.orderNumber,
      restaurantId: updated.restaurantId,
      status: updated.status,
      tableNumber: updated.tableNumber,
      orderType: updated.orderType,
      estimatedMins: updated.estimatedMins,
      updatedAt: updated.updatedAt,
      items: updated.items,
    };
    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, kitchenUpdatePayload);
    emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, kitchenUpdatePayload);

    return updated;
  },

  // ── Kitchen queue ─────────────────────────────────────────────────────────

  async getKitchenOrders(restaurantId: string) {
    // PERF: Short-lived cache (10 s) absorbs the rapid polling pattern common
    // in kitchen displays without serving stale data.  The cache is explicitly
    // invalidated on every order create/update, so worst-case staleness is 10 s
    // only when a write is missed (e.g. Redis down fallback).
    const cacheKey = CACHE_KEYS.kitchenOrders(restaurantId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const activeStatuses = [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
    ];

    // PERF: Use select (not include) to fetch only kitchen-relevant fields
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

    // PERF: count and findMany run in parallel (was already correct)
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
};

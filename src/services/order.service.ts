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
} from '../utils/stateMachine';

const TAX_RATE = 0.05; // 5%

export const orderService = {
  async createOrder(slugOrId: string, input: CreateOrderInput) {
    // Resolve slug to real restaurantId
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');
    const restaurantId = restaurant.id;

    // Validate all menu items exist and are available
    const menuItemIds = input.items.map((i) => i.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, category: { restaurantId } },
    });

    if (menuItems.length !== menuItemIds.length) {
      throw ApiError.notFound('One or more menu items not found');
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
    const taxAmount = Math.round(subtotal * TAX_RATE * 100) / 100;
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
          subtotal,
          taxAmount,
          totalAmount,
          estimatedMins: maxPrep + 5,
          items: { create: orderItems },
          statusHistory: {
            create: { status: OrderStatus.PENDING, note: 'Order placed' },
          },
        },
        include: { items: true, statusHistory: true },
      }),
    ]);

    // Emit real-time events after the transaction commits
    emitToKitchen(restaurantId, SOCKET_EVENTS.KITCHEN_NEW_ORDER, order);
    emitToRestaurant(restaurantId, SOCKET_EVENTS.ORDER_CREATED, order);

    return order;
  },

  async getOrderById(id: string) {
    const cacheKey = CACHE_KEYS.order(id);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } } },
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
        statusHistory: { orderBy: { createdAt: 'asc' }, select: { status: true, note: true, createdAt: true } },
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
      if (input.status === OrderStatus.PREPARING) timestamps.preparedAt = new Date();
      if (input.status === OrderStatus.READY) timestamps.readyAt = new Date();
      if (input.status === OrderStatus.DELIVERED) timestamps.deliveredAt = new Date();
      if (input.status === OrderStatus.CANCELLED) timestamps.cancelledAt = new Date();

      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: input.status,
          ...timestamps,
        },
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
          status: input.status,
          note: input.note,
        },
      });

      const refreshed = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } } },
      });

      if (!refreshed) throw ApiError.notFound('Order not found after update');
      return refreshed;
    });

    await cacheDel(CACHE_KEYS.order(orderId));

    // Emit events
    emitToOrder(orderId, SOCKET_EVENTS.ORDER_STATUS_CHANGED, {
      orderId,
      status: input.status,
      timestamp: new Date(),
    });

    emitToKitchen(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);
    emitToAdmin(restaurantId, SOCKET_EVENTS.ORDER_UPDATED, updated);

    if (input.status === OrderStatus.READY) {
      emitToOrder(orderId, SOCKET_EVENTS.KITCHEN_ORDER_READY, { orderId });
    }

    return updated;
  },

  // ── Kitchen queue ─────────────────────────────────────────────────────────────

  async getKitchenOrders(restaurantId: string) {
    const activeStatuses = [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.READY,
    ];

    return prisma.order.findMany({
      where: { restaurantId, status: { in: activeStatuses } },
      include: { items: { include: { menuItem: { select: { kitchenType: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  },

  // ── Admin order listing ───────────────────────────────────────────────────────

  async getAdminOrders(restaurantId: string, query: OrderQuery) {
    const pagination = parsePagination(query.page, query.limit);

    const where: Record<string, unknown> = { restaurantId };
    if (query.status) where.status = query.status;
    if (query.orderType) where.orderType = query.orderType;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lte: new Date(query.to) }),
      };
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: { items: { select: { name: true, quantity: true, price: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, meta: buildPaginationMeta(total, pagination.page, pagination.limit) };
  },
};

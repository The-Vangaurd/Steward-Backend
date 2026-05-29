import { z } from 'zod';
import { OrderType, OrderStatus } from '@prisma/client';

const orderItemSchema = z.object({
  menuItemId: z.string().cuid(),
  quantity: z.number().int().min(1).max(100),
  notes: z.string().max(500).optional(),
});

export const createOrderSchema = z.object({
  orderType: z.nativeEnum(OrderType).default(OrderType.DINE_IN),
  tableNumber: z.string().max(20).optional(),
  notes: z.string().max(1000).optional(),
  deliveryAddress: z.string().max(500).optional(),
  customerName: z.string().max(100).optional(),
  customerPhone: z.string().max(20).optional(),
  customerEmail: z.string().email().optional(),
  items: z.array(orderItemSchema).min(1, 'Order must have at least one item'),
  guestId: z.string().max(100).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
  note: z.string().max(500).optional(),
});

export const orderQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional().transform((val) => {
    if (!val) return undefined;
    const values = val.split(',').map(v => v.trim());
    return values.length === 1 ? values[0] : values;
  }).pipe(z.union([z.nativeEnum(OrderStatus), z.array(z.nativeEnum(OrderStatus))]).optional()),
  orderType: z.nativeEnum(OrderType).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type OrderQuery = z.infer<typeof orderQuerySchema>;
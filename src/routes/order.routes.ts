import { Router } from 'express';
import { orderController } from '../controllers/order.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import {
  createOrderSchema,
  updateOrderStatusSchema,
  orderQuerySchema,
} from '../validators/order.validator';
import { UserRole } from '@prisma/client';
import { authRateLimiter } from '../middlewares/rateLimiter.middleware';

const router = Router();

// ── Guards ────────────────────────────────────────────────────────────────────
const kitchenGuard = [
  authenticate,
  requireRole(UserRole.KITCHEN_STAFF, UserRole.WAITER, UserRole.ADMIN, UserRole.SUPER_ADMIN),
];

const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

// ── Kitchen ───────────────────────────────────────────────────────────────────
router.get('/kitchen/queue', ...kitchenGuard, orderController.getKitchenOrders);
router.patch('/kitchen/:id/status', ...kitchenGuard, validate(updateOrderStatusSchema), orderController.updateOrderStatus);
// Kitchen undo: POST /v1/orders/kitchen/:id/undo
router.post('/kitchen/:id/undo', ...kitchenGuard, orderController.undoOrderStatus);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/list', ...adminGuard, validate(orderQuerySchema, 'query'), orderController.getAdminOrders);

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/:id/track', orderController.trackOrder);
router.get('/:id', orderController.getOrderById);
router.post('/:restaurantId', authRateLimiter, validate(createOrderSchema), orderController.createOrder);

export default router;

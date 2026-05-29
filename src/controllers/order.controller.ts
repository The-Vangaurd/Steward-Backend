import { Request, Response } from 'express';
import { orderService } from '../services/order.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { verifyGuestToken } from '../utils/jwt';

export const orderController = {
  // ── Customer ───────────────────────────────────────────────────────────────

  createOrder: asyncHandler(async (req: Request, res: Response) => {
    const { restaurantId } = req.params;
    const { order, recallToken } = await orderService.createOrder(restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, { ...order, recallToken });
  }),

  getOrderById: asyncHandler(async (req: Request, res: Response) => {
    const order = await orderService.getOrderById(req.params.id);
    sendSuccess(res, HTTP_STATUS.OK, order);
  }),

  trackOrder: asyncHandler(async (req: Request, res: Response) => {
    const tracking = await orderService.getOrderTracking(req.params.id);
    sendSuccess(res, HTTP_STATUS.OK, tracking);
  }),

  // ── Kitchen ───────────────────────────────────────────────────────────────

  getKitchenOrders: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant assigned');
    const orders = await orderService.getKitchenOrders(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, orders);
  }),

  updateOrderStatus: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant assigned');
    const updated = await orderService.updateOrderStatus(req.params.id, restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.OK, updated);
  }),

  /**
   * Kitchen undo — revert the last status transition by one step.
   * POST /v1/orders/:id/undo
   * Body: { note?: string }
   */
  undoOrderStatus: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant assigned');
    const updated = await orderService.undoOrderStatus(req.params.id, restaurantId, req.body?.note);
    sendSuccess(res, HTTP_STATUS.OK, updated);
  }),

  // ── Admin ──────────────────────────────────────────────────────────────────

  getAdminOrders: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { orders, meta } = await orderService.getAdminOrders(restaurantId, req.query as any);
    sendSuccess(res, HTTP_STATUS.OK, orders, meta);
  }),

  getGuestOrders: asyncHandler(async (req: Request, res: Response) => {
    const { guestId, restaurantSlug } = req.query;
    if (!guestId || !restaurantSlug) {
      throw ApiError.badRequest('Missing required query parameters: guestId and restaurantSlug');
    }

    const orders = await orderService.getGuestOrders(guestId as string, restaurantSlug as string);
    sendSuccess(res, HTTP_STATUS.OK, orders);
  }),

  /**
   * GET /orders/recall?token=…
   * No auth required — verifies the guest JWT and returns all orders for that
   * guest at that restaurant. Fallback for users who cleared their cookies.
   */
  recallGuestOrders: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      throw ApiError.badRequest('Missing required query parameter: token');
    }

    const { guestId, restaurantSlug } = verifyGuestToken(token);
    const orders = await orderService.recallGuestOrders(guestId, restaurantSlug);
    sendSuccess(res, HTTP_STATUS.OK, orders);
  }),

  cancelGuestOrder: asyncHandler(async (req: Request, res: Response) => {
    const { guestId } = req.body;
    if (!guestId) {
      throw ApiError.badRequest('Missing required body parameter: guestId');
    }

    const updated = await orderService.cancelGuestOrder(req.params.id, guestId);
    sendSuccess(res, HTTP_STATUS.OK, updated);
  }),
};

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { orderService } from '../services/order.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { verifySignedGuestId } from '../utils/guestToken';

export const orderController = {
  // ── Customer ───────────────────────────────────────────────────────────────

  createOrder: asyncHandler(async (req: Request, res: Response) => {
    const { restaurantId } = req.params;
    const order = await orderService.createOrder(restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, order);
  }),

  getOrderById: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.query;
    if (!token) throw ApiError.unauthorized('Missing recall token');

    try {
      const decoded = jwt.verify(token as string, env.JWT_GUEST_SECRET) as {
        orderId?: string;
        guestId: string;
      };
      const order = await orderService.getOrderById(req.params.id);
      if (order.guestId !== decoded.guestId) {
        throw ApiError.unauthorized('Unauthorized order access');
      }
      sendSuccess(res, HTTP_STATUS.OK, order);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.unauthorized('Invalid or expired recall token');
    }
  }),

  trackOrder: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.query;
    if (!token) throw ApiError.unauthorized('Missing recall token');

    try {
      const decoded = jwt.verify(token as string, env.JWT_GUEST_SECRET) as {
        orderId?: string;
        guestId: string;
      };
      const tracking = await orderService.getOrderTracking(req.params.id);
      if (tracking.guestId !== decoded.guestId) {
        throw ApiError.unauthorized('Unauthorized order tracking access');
      }
      sendSuccess(res, HTTP_STATUS.OK, tracking);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.unauthorized('Invalid or expired recall token');
    }
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
    const { guestId, restaurantSlug, sig, token } = req.query;

    if (token) {
      try {
        const decoded = jwt.verify(token as string, env.JWT_GUEST_SECRET) as {
          guestId: string;
          restaurantSlug: string;
        };
        const orders = await orderService.getGuestOrders(decoded.guestId, decoded.restaurantSlug);
        return sendSuccess(res, HTTP_STATUS.OK, orders);
      } catch (err) {
        throw ApiError.unauthorized('Invalid or expired recall token');
      }
    }

    if (!guestId || !restaurantSlug) {
      throw ApiError.badRequest('Missing required query parameters: guestId and restaurantSlug');
    }

    if (!sig || !verifySignedGuestId(guestId as string, sig as string)) {
      throw ApiError.unauthorized('Invalid or unsigned guest identity', 'UNSIGNED_GUEST_ID');
    }

    const orders = await orderService.getGuestOrders(guestId as string, restaurantSlug as string);
    sendSuccess(res, HTTP_STATUS.OK, orders);
  }),

  recallOrders: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.query;
    if (!token) {
      throw ApiError.badRequest('Missing required query parameter: token');
    }

    try {
      const decoded = jwt.verify(token as string, env.JWT_GUEST_SECRET) as {
        guestId: string;
        restaurantSlug: string;
      };
      const orders = await orderService.getGuestOrders(decoded.guestId, decoded.restaurantSlug);
      sendSuccess(res, HTTP_STATUS.OK, orders);
    } catch (err) {
      throw ApiError.unauthorized('Invalid or expired recall token');
    }
  }),

  cancelGuestOrder: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      throw ApiError.badRequest('Missing required body parameter: token');
    }

    let guestId: string;
    try {
      const decoded = jwt.verify(token, env.JWT_GUEST_SECRET) as {
        orderId?: string;
        guestId: string;
        restaurantSlug: string;
      };
      guestId = decoded.guestId;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.unauthorized('Invalid or expired recall token');
    }

    const updated = await orderService.cancelGuestOrder(req.params.id, guestId);
    sendSuccess(res, HTTP_STATUS.OK, updated);
  }),

  lookupOrder: asyncHandler(async (req: Request, res: Response) => {
    const { orderNumber, restaurantSlug, customerPhoneSuffix } = req.query;
    if (!orderNumber || !restaurantSlug) {
      throw ApiError.badRequest('Missing required query parameters: orderNumber and restaurantSlug');
    }

    const order = await orderService.lookupOrder(
      orderNumber as string,
      restaurantSlug as string,
      customerPhoneSuffix as string | undefined
    );
    sendSuccess(res, HTTP_STATUS.OK, order);
  }),
};

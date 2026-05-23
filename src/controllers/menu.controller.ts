import { Request, Response } from 'express';
import { menuService } from '../services/menu.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { emitToRestaurant, emitToKitchen } from '../sockets';

export const menuController = {
  // ── Public ────────────────────────────────────────────────────────────────────

  getMenu: asyncHandler(async (req: Request, res: Response) => {
    const { restaurantId } = req.params;
    const menu = await menuService.getPublicMenu(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, menu);
  }),

  getMenuItemById: asyncHandler(async (req: Request, res: Response) => {
    const item = await menuService.getMenuItemById(req.params.id);
    sendSuccess(res, HTTP_STATUS.OK, item);
  }),

  searchMenu: asyncHandler(async (req: Request, res: Response) => {
    const { restaurantId } = req.params;
    const query = String(req.query.q ?? '').trim();
    if (!query) throw ApiError.badRequest('Search query is required');
    const items = await menuService.searchMenuItems(restaurantId, query);
    sendSuccess(res, HTTP_STATUS.OK, items);
  }),

  // ── Admin Categories ──────────────────────────────────────────────────────────

  getCategories: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const categories = await menuService.getCategories(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, categories);
  }),

  createCategory: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const category = await menuService.createCategory(restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, category);
  }),

  updateCategory: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const category = await menuService.updateCategory(req.params.id, restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.OK, category);
  }),

  deleteCategory: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    await menuService.deleteCategory(req.params.id, restaurantId);
    sendSuccess(res, HTTP_STATUS.OK);
  }),

  // ── Admin Menu Items ──────────────────────────────────────────────────────────

  getAdminMenuItems: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { items, meta } = await menuService.getAdminMenuItems(
      restaurantId,
      req.query.page,
      req.query.limit,
    );
    sendSuccess(res, HTTP_STATUS.OK, items, meta);
  }),

  createMenuItem: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const item = await menuService.createMenuItem(restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, item);
  }),

  updateMenuItem: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const item = await menuService.updateMenuItem(req.params.id, restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.OK, item);
  }),

  deleteMenuItem: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    await menuService.deleteMenuItem(req.params.id, restaurantId);
    sendSuccess(res, HTTP_STATUS.OK);
  }),

  setItemAvailability: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { isAvailable } = req.body as { isAvailable: boolean };
    const item = await menuService.setItemAvailability(req.params.id, restaurantId, isAvailable);

    // Emit WebSocket event to both restaurant and kitchen rooms
    const payload = { itemId: req.params.id, isAvailable };
    emitToRestaurant(restaurantId, 'item:availability_changed', payload);
    emitToKitchen(restaurantId, 'item:availability_changed', payload);

    sendSuccess(res, HTTP_STATUS.OK, item);
  }),

  uploadImage: asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded');
    const url = await menuService.uploadImage(req.file.buffer, req.file.mimetype);
    sendSuccess(res, HTTP_STATUS.OK, { url });
  }),
};

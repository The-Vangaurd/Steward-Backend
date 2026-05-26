import { Request, Response } from 'express';
import { settingsService, SettingsPatch } from '../services/settings.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { z } from 'zod';
import { ApiError } from '../utils/ApiError';

const patchSchema = z.object({
  taxRate: z.number().min(0).max(1).optional(),
  serviceCharge: z.number().min(0).max(1).optional(),
  primaryColor: z.string().max(20).nullable().optional(),
  secondaryColor: z.string().max(20).nullable().optional(),
  accentColor: z.string().max(20).nullable().optional(),
  fontHeading: z.string().max(100).nullable().optional(),
  fontBody: z.string().max(100).nullable().optional(),
  customCss: z.string().max(50_000).nullable().optional(),
  openingHours: z.unknown().optional(),
  offlineMode: z.boolean().optional(),
  autoAcceptOrders:   z.boolean().optional(),
  estimatedPrepMins:  z.number().int().min(1).max(120).optional(),
  offlineModeMessage: z.string().max(500).nullable().optional(),
  serviceChargeLabel: z.string().max(100).nullable().optional(),
  notifyOnNewOrder:   z.boolean().optional(),
  notifyOnLowStock:   z.boolean().optional(),
  notifyEmail:        z.string().email().max(255).nullable().optional(),
  showCalories:       z.boolean().optional(),
  showPrepTime:       z.boolean().optional(),
  showVegBadge:       z.boolean().optional(),
  menuLayout:         z.string().max(20).optional(),
});

const profileSchema = z.object({
  name:        z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  phone:       z.string().max(20).nullable().optional(),
  email:       z.string().email().max(255).nullable().optional(),
  address:     z.unknown().optional(),   // stored as JSON
  timezone:    z.string().max(50).optional(),
  currency:    z.string().max(10).optional(),
  logoUrl:     z.string().nullable().optional(),
  bannerUrl:   z.string().nullable().optional(),
});

export const settingsController = {
  getSettings: asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const restaurantId = authReq.user.restaurantId;

    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const settings = await settingsService.getSettings(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, settings);
  }),

  updateSettings: asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const restaurantId = authReq.user.restaurantId;

    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid settings payload', 'VALIDATION_ERROR');

    const settings = await settingsService.updateSettings(restaurantId, parsed.data as SettingsPatch);
    sendSuccess(res, HTTP_STATUS.OK, settings);
  }),

  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const restaurantId = authReq.user.restaurantId;

    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid profile payload', 'VALIDATION_ERROR');

    const profile = await settingsService.updateProfile(restaurantId, parsed.data);
    sendSuccess(res, HTTP_STATUS.OK, profile);
  }),

  uploadAsset: asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const restaurantId = authReq.user.restaurantId;

    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');
    if (!req.file) throw ApiError.badRequest('No file uploaded');

    const type = req.body?.type as 'logo' | 'banner';
    if (type !== 'logo' && type !== 'banner') {
      throw ApiError.badRequest('Invalid asset type. Expected logo or banner.');
    }

    const url = await settingsService.uploadAsset(restaurantId, req.file.buffer, req.file.mimetype, type);
    sendSuccess(res, HTTP_STATUS.OK, { url });
  }),

  getTheme: asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const theme = await settingsService.getTheme(slug);
    sendSuccess(res, HTTP_STATUS.OK, theme);
  }),
};
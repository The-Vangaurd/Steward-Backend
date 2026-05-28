import { Request, Response } from 'express';
import { settingsService, SettingsPatch } from '../services/settings.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { z } from 'zod';
import { ApiError } from '../utils/ApiError';

// ── Validation schemas ────────────────────────────────────────────────────────
//
// FIELD MAPPING NOTE:
// The frontend sends fontBody and fontHeading (mapped from its fontFamily field
// by the normalisation layer in useRestaurantSettings.ts). This controller
// accepts BOTH column names. It does NOT accept a `fontFamily` field — if the
// frontend accidentally sends it, Zod strips it silently. The correct fix is in
// the frontend hook, not by accepting arbitrary field aliases here.

const patchSchema = z.object({
  taxRate:            z.number().min(0).max(100).optional(),
  serviceCharge:      z.number().min(0).max(100).optional(),
  primaryColor:       z.string().max(20).nullable().optional(),
  secondaryColor:     z.string().max(20).nullable().optional(),
  accentColor:        z.string().max(20).nullable().optional(),
  fontHeading:        z.string().max(100).nullable().optional(),
  fontBody:           z.string().max(100).nullable().optional(),
  customCss:          z.string().max(50_000).nullable().optional(),
  openingHours:       z.unknown().optional(),
  offlineMode:        z.boolean().optional(),
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
  address:     z.unknown().optional(),
  timezone:    z.string().max(50).optional(),
  currency:    z.string().max(10).optional(),
  logoUrl:     z.string().nullable().optional(),
  bannerUrl:   z.string().nullable().optional(),
});

// ── Controller ────────────────────────────────────────────────────────────────

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
    if (!parsed.success) {
      throw ApiError.badRequest('Invalid settings payload', 'VALIDATION_ERROR');
    }

    // Check that at least one valid field was sent (after Zod strips unknowns)
    if (Object.keys(parsed.data).length === 0) {
      throw ApiError.badRequest(
        'No valid settings fields provided. ' +
        'Note: fontFamily is not a valid field; use fontBody and fontHeading instead.',
        'VALIDATION_ERROR',
      );
    }

    // updateSettings now returns the full combined settings object
    const settings = await settingsService.updateSettings(restaurantId, parsed.data as SettingsPatch);
    sendSuccess(res, HTTP_STATUS.OK, settings);
  }),

  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const restaurantId = authReq.user.restaurantId;

    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Invalid profile payload', 'VALIDATION_ERROR');
    }

    // updateProfile now returns the full combined settings object so that
    // the PATCH /settings/profile response includes branding and operations
    // fields — preventing the frontend cache from losing non-profile values.
    const settings = await settingsService.updateProfile(restaurantId, {
      ...parsed.data,
      address: parsed.data.address as import('@prisma/client/runtime/library').InputJsonValue | undefined,
    });
    sendSuccess(res, HTTP_STATUS.OK, settings);
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

    // uploadAsset throws ApiError.serviceUnavailable if Cloudinary is not
    // configured — the error middleware will return a 503 with a clear message.
    const url = await settingsService.uploadAsset(
      restaurantId,
      req.file.buffer,
      req.file.mimetype,
      type,
    );
    sendSuccess(res, HTTP_STATUS.OK, { url });
  }),

  getTheme: asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const theme = await settingsService.getTheme(slug);
    sendSuccess(res, HTTP_STATUS.OK, theme);
  }),
};
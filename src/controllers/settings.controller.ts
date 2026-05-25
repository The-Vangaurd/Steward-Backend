import { Request, Response } from 'express';
import { settingsService } from '../services/settings.service';
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

    const settings = await settingsService.updateSettings(restaurantId, parsed.data);
    sendSuccess(res, HTTP_STATUS.OK, settings);
  }),

  getTheme: asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const theme = await settingsService.getTheme(slug);
    sendSuccess(res, HTTP_STATUS.OK, theme);
  }),
};
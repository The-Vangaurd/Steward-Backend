import { Request, Response } from 'express';
import { shiftService } from '../services/shift.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';

export const shiftController = {
  listShifts: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const result = await shiftService.listShifts(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, result);
  }),

  createShift: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const { name, dayOfWeek, startTime, endTime } = req.body;
    if (!name || dayOfWeek === undefined || !startTime || !endTime) {
      throw ApiError.badRequest('Missing required shift fields');
    }

    const shift = await shiftService.createShift(restaurantId, {
      name,
      dayOfWeek: Number(dayOfWeek),
      startTime,
      endTime
    });
    sendSuccess(res, HTTP_STATUS.CREATED, shift);
  }),

  updateShift: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const shift = await shiftService.updateShift(restaurantId, req.params.id, req.body);
    sendSuccess(res, HTTP_STATUS.OK, shift);
  }),

  toggleShift: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const shift = await shiftService.toggleShift(restaurantId, req.params.id);
    sendSuccess(res, HTTP_STATUS.OK, shift);
  }),

  deleteShift: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    await shiftService.deleteShift(restaurantId, req.params.id);
    sendSuccess(res, HTTP_STATUS.OK);
  }),
};

import { Request, Response } from 'express';
import { staffService } from '../services/staff.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';

export const staffController = {
  listStaff: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { staff, meta } = await staffService.listStaff(
      restaurantId,
      req.query.page,
      req.query.limit,
    );
    sendSuccess(res, HTTP_STATUS.OK, staff, meta);
  }),

  createStaff: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const member = await staffService.createStaffMember(restaurantId, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, member);
  }),

  updateStaff: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const member = await staffService.updateStaffMember(
      restaurantId,
      req.params.id,
      req.body,
    );
    sendSuccess(res, HTTP_STATUS.OK, member);
  }),

  deactivateStaff: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    // Use the existing update method to flip the active flag instead of a missing deactivate method
    await staffService.updateStaffMember(restaurantId, req.params.id, { isActive: false });
    sendSuccess(res, HTTP_STATUS.OK);
  }),
};
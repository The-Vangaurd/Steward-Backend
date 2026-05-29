import { Request, Response } from 'express';
import { auditService } from '../services/audit.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';

export const auditController = {
  listAuditLogs: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const { action, resourceType, actorId, from, to, page, limit } = req.query;

    const { logs, meta } = await auditService.listAuditLogs(restaurantId, {
      action: action as string,
      resourceType: resourceType as string,
      actorId: actorId as string,
      from: from as string,
      to: to as string,
      page,
      limit,
    });

    sendSuccess(res, HTTP_STATUS.OK, logs, meta);
  }),

  getFilters: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId;
    if (!restaurantId) throw ApiError.forbidden('No restaurant associated with account');

    const data = await auditService.getFilters(restaurantId);
    sendSuccess(res, HTTP_STATUS.OK, data);
  }),
};

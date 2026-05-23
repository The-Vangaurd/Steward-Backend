import { Request, Response } from 'express';
import { analyticsService } from '../services/analytics.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';

const parseDateRange = (query: Record<string, unknown>) => {
  const to = query.to ? new Date(String(query.to)) : new Date();
  const from = query.from
    ? new Date(String(query.from))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000); // default 30d
  to.setHours(23, 59, 59, 999);
  return { from, to };
};

export const analyticsController = {
  getSummary: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const summary = await analyticsService.getSummary(restaurantId, from, to);
    sendSuccess(res, HTTP_STATUS.OK, summary);
  }),

  getRevenue: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const series = await analyticsService.getRevenueSeries(restaurantId, from, to);
    sendSuccess(res, HTTP_STATUS.OK, series);
  }),

  getTopItems: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const items = await analyticsService.getTopItems(restaurantId, from, to);
    sendSuccess(res, HTTP_STATUS.OK, items);
  }),

  getHourly: asyncHandler(async (req: Request, res: Response) => {
    const restaurantId = (req as AuthenticatedRequest).user.restaurantId!;
    const { from, to } = parseDateRange(req.query as Record<string, unknown>);
    const hourly = await analyticsService.getHourlyDistribution(restaurantId, from, to);
    sendSuccess(res, HTTP_STATUS.OK, hourly);
  }),
};

import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';

/**
 * Restricts a route to users with one of the specified roles.
 * Must be used AFTER the authenticate middleware.
 */
export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;

    if (!roles.includes(authReq.user.role)) {
      throw ApiError.forbidden(
        `Access denied. Required role(s): ${roles.join(', ')}`,
      );
    }
    next();
  };

/**
 * Ensures the authenticated user belongs to the restaurant specified in params.
 * Super admins bypass this check.
 */
export const requireRestaurantAccess = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const authReq = req as AuthenticatedRequest;
  const { restaurantId } = authReq.params;
  const user = authReq.user;

  if (user.role === UserRole.SUPER_ADMIN) {
    return next();
  }

  if (!restaurantId || user.restaurantId !== restaurantId) {
    throw ApiError.forbidden('Access to this restaurant is denied');
  }

  next();
};
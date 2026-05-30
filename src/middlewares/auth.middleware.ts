import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { AuthenticatedRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { prisma } from '../config/database';

export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('No bearer token provided');
    }

    const token = authHeader.slice(7);
    // verifyAccessToken throws ApiError on invalid/expired token — propagates to errorHandler.
    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    });

    if (!user || !user.isActive) {
      throw ApiError.forbidden('Account deactivated or not found');
    }

    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      restaurantId: payload.restaurantId,
    };

    next();
  },
);

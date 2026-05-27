import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

const getCookieOptions = () => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as const,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/v1/auth/refresh',
  };
};

const getClearCookieOptions = () => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as const,
    path: '/v1/auth/refresh',
  };
};

export const authController = {
  // ── Existing: staff registration ──────────────────────────────────────────
  register: asyncHandler(async (req: Request, res: Response) => {
    const user = await authService.register(req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, user);
  }),

  // ── New: owner + restaurant registration ──────────────────────────────────
  registerOwner: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.registerOwner(req.body);

    // Issue refresh token cookie (same shape as login)
    res.cookie('refreshToken', result.refreshToken, getCookieOptions());

    sendSuccess(res, HTTP_STATUS.CREATED, {
      accessToken: result.accessToken,
      user: result.user,
      restaurant: result.restaurant,
    });
  }),

  // ── Existing: login ───────────────────────────────────────────────────────
  login: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.login(req.body);

    res.cookie('refreshToken', result.refreshToken, getCookieOptions());

    sendSuccess(res, HTTP_STATUS.OK, {
      accessToken: result.accessToken,
      user: result.user,
    });
  }),

  // ── Existing: refresh ─────────────────────────────────────────────────────
  refresh: asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) throw ApiError.unauthorized('No refresh token provided');

    const tokens = await authService.refresh(refreshToken);

    res.cookie('refreshToken', tokens.refreshToken, getCookieOptions());

    sendSuccess(res, HTTP_STATUS.OK, { accessToken: tokens.accessToken });
  }),

  // ── Existing: logout ──────────────────────────────────────────────────────
  logout: asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) await authService.logout(refreshToken);

    res.clearCookie('refreshToken', getClearCookieOptions());
    sendSuccess(res, HTTP_STATUS.OK);
  }),

  // ── Existing: me ──────────────────────────────────────────────────────────
  me: asyncHandler(async (req: Request, res: Response) => {
    const user = await authService.me((req as AuthenticatedRequest).user.id);
    sendSuccess(res, HTTP_STATUS.OK, user);
  }),
};

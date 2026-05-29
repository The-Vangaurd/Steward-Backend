import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { AuthenticatedRequest } from '../types';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

export const getCookieOptions = () => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    partitioned: isProd, // CHIPS: required for cross-site cookies in modern browsers
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/v1/auth/refresh',
  };
};

/** Staff sessions use a shorter 12-hour shift window. */
const getStaffCookieOptions = () => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    partitioned: isProd, // CHIPS: required for cross-site cookies in modern browsers
    maxAge: 12 * 60 * 60 * 1000, // 12 hours — one shift
    path: '/v1/auth/refresh',
  };
};

const getClearCookieOptions = () => {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    partitioned: isProd, // CHIPS: required for cross-site cookies in modern browsers
    path: '/v1/auth/refresh',
  };
};

export const authController = {
  // ── Existing: staff registration ──────────────────────────────────────────
  register: asyncHandler(async (req: Request, res: Response) => {
    const user = await authService.register(req.body, (req as AuthenticatedRequest).user?.restaurantId ?? '');
    sendSuccess(res, HTTP_STATUS.CREATED, user);
  }),

  // ── New: owner + restaurant registration ──────────────────────────────────
  registerOwner: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.registerOwner(req.body);

    res.cookie('refreshToken', result.refreshToken, getCookieOptions());

    sendSuccess(res, HTTP_STATUS.CREATED, {
      accessToken: result.accessToken,
      user: result.user,
      restaurant: result.restaurant,
    });
  }),

  // ── Existing: owner/admin email+password login ─────────────────────────────
  login: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.login(req.body);

    res.cookie('refreshToken', result.refreshToken, getCookieOptions());

    sendSuccess(res, HTTP_STATUS.OK, {
      accessToken: result.accessToken,
      user: result.user,
    });
  }),

  // ── NEW: staff restaurant-code + PIN login ─────────────────────────────────
  staffLogin: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.loginStaff(req.body);

    // Staff refresh cookie is scoped to one shift (12 h).
    // The same /v1/auth/refresh endpoint works — the shorter expiry is enforced
    // at the session level in the DB, not just in the cookie.
    res.cookie('refreshToken', result.refreshToken, getStaffCookieOptions());

    sendSuccess(res, HTTP_STATUS.OK, {
      accessToken: result.accessToken,
      user: result.user,
      restaurant: result.restaurant,
    });
  }),

  // ── Existing: refresh ─────────────────────────────────────────────────────
  refresh: asyncHandler(async (req: Request, res: Response) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
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

  // ── New: verify email ──────────────────────────────────────────────────────
  verifyEmail: asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.query;
    if (!token) {
      throw ApiError.badRequest('Missing verification token');
    }

    const { getVerificationEmail, deleteVerificationToken } = require('../utils/emailVerification');
    const email = await getVerificationEmail(token as string);
    if (!email) {
      throw ApiError.badRequest('Invalid or expired verification token');
    }

    const { prisma } = require('../config/database');
    await prisma.user.update({
      where: { email },
      data: {
        emailVerified: true,
        isActive: true,
      },
    });

    await deleteVerificationToken(token as string);

    sendSuccess(res, HTTP_STATUS.OK, { message: 'Email verified successfully. You can now log in.' });
  }),
};

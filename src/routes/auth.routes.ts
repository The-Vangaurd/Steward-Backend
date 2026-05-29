import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { authRateLimiter } from '../middlewares/rateLimiter.middleware';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  ownerRegisterSchema,
  staffLoginSchema,
} from '../validators/auth.validator';
import oauthRouter from './oauth.routes';

const router = Router();

// ── Staff registration ─────────────────────────────────────────────────────
router.post(
  '/register',
  authRateLimiter,
  authenticate,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(registerSchema),
  authController.register,
);

// ── Owner + restaurant registration ───────────────────────────────────────
router.post(
  '/owner-register',
  authRateLimiter,
  validate(ownerRegisterSchema),
  authController.registerOwner,
);

// ── Email + password login ────────────────────────────────────────────────
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);

// ── Staff PIN login ───────────────────────────────────────────────────────
router.post('/staff-login', authRateLimiter, validate(staffLoginSchema), authController.staffLogin);

// ── Token management ──────────────────────────────────────────────────────
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);

// ── Google OAuth (mounted at /google and /google/callback) ────────────────
router.use('/', oauthRouter);

export default router;
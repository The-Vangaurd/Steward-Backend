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

const router = Router();

// ── Staff registration (existing — KITCHEN_STAFF) ──────────────────────────
router.post(
  '/register',
  authRateLimiter,
  authenticate,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  validate(registerSchema),
  authController.register,
);

// ── Owner + restaurant registration (existing) ─────────────────────────────
router.post(
  '/owner-register',
  authRateLimiter,
  validate(ownerRegisterSchema),
  authController.registerOwner,
);

// ── Owner / admin email + password login (existing) ────────────────────────
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);

// ── Staff restaurant-code + PIN login (NEW) ────────────────────────────────
// Intentionally uses the same authRateLimiter as email login to prevent
// brute-force against the 4-digit PIN space (10,000 combinations).
router.post('/staff-login', authRateLimiter, validate(staffLoginSchema), authController.staffLogin);

// ── Token management ───────────────────────────────────────────────────────
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);

export default router;

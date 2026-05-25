import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { authRateLimiter } from '../middlewares/rateLimiter.middleware';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  ownerRegisterSchema,
} from '../validators/auth.validator';

const router = Router();

// ── Staff registration (existing — KITCHEN_STAFF) ──────────────────────────
router.post('/register', authRateLimiter, validate(registerSchema), authController.register);

// ── Owner + restaurant registration (new) ──────────────────────────────────
router.post(
  '/owner-register',
  authRateLimiter,
  validate(ownerRegisterSchema),
  authController.registerOwner,
);

// ── Existing auth routes ────────────────────────────────────────────────────
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);

export default router;

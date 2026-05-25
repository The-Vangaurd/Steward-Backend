import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { authRateLimiter } from '../middlewares/rateLimiter.middleware';
import {
  loginSchema,
  refreshTokenSchema,
  ownerRegisterSchema,
} from '../validators/auth.validator';

const router = Router();

// ── Owner + restaurant registration (public — for new SaaS signups) ──────────
router.post(
  '/owner-register',
  authRateLimiter,
  validate(ownerRegisterSchema),
  authController.registerOwner,
);

// ── Existing auth routes ──────────────────────────────────────────────────────
router.post('/login', authRateLimiter, validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);

// NOTE: POST /auth/register (public kitchen-staff self-registration) has been
// intentionally removed. Staff accounts are now created exclusively by an
// authenticated ADMIN via POST /v1/admin/staff — see staff.routes.ts.

export default router;

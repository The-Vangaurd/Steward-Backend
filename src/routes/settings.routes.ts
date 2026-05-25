import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';

const router = Router();

// GET  /v1/settings  — admin reads their restaurant settings
router.get('/', authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN), settingsController.getSettings);
// PATCH /v1/settings — admin patches their restaurant settings
router.patch('/', authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN), settingsController.updateSettings);

export default router;

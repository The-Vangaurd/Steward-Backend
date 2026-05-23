import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';

const router = Router();
const guard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

router.get('/summary', ...guard, analyticsController.getSummary);
router.get('/revenue', ...guard, analyticsController.getRevenue);
router.get('/top-items', ...guard, analyticsController.getTopItems);
router.get('/hourly', ...guard, analyticsController.getHourly);

export default router;

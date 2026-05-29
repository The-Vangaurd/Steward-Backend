import { Router } from 'express';
import { auditController } from '../controllers/audit.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';

const router = Router();
const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

router.get('/', ...adminGuard, auditController.listAuditLogs);
router.get('/filters', ...adminGuard, auditController.getFilters);

export default router;

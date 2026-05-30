import { Router } from 'express';
import { staffController } from '../controllers/staff.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';

const router = Router();
const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

router.get('/', ...adminGuard, staffController.listStaff);
router.post('/', ...adminGuard, staffController.createStaff);
router.post('/invite', ...adminGuard, staffController.inviteStaff);
router.patch('/:id', ...adminGuard, staffController.updateStaff);
router.delete('/:id', ...adminGuard, staffController.deactivateStaff);

export default router;

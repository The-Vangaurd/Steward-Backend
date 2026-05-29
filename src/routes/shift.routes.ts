import { Router } from 'express';
import { shiftController } from '../controllers/shift.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';

const router = Router();
const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

router.get('/', ...adminGuard, shiftController.listShifts);
router.post('/', ...adminGuard, shiftController.createShift);
router.patch('/:id', ...adminGuard, shiftController.updateShift);
router.post('/:id/toggle', ...adminGuard, shiftController.toggleShift);
router.delete('/:id', ...adminGuard, shiftController.deleteShift);

export default router;

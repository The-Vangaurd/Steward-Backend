import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import { UserRole } from '@prisma/client';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

// GET  /v1/settings  — admin reads their restaurant settings
router.get('/', ...adminGuard, settingsController.getSettings);
// PATCH /v1/settings — admin patches their restaurant settings
router.patch('/', ...adminGuard, settingsController.updateSettings);

// PATCH /v1/settings/profile — admin patches their restaurant profile (Prompt 6)
router.patch('/profile', ...adminGuard, settingsController.updateProfile);

// POST /v1/settings/upload — uploadLogo/banner via Cloudinary (Prompt 5)
router.post('/upload', ...adminGuard, upload.single('file'), settingsController.uploadAsset);

export default router;

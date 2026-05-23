import { Router } from 'express';
import multer from 'multer';
import { menuController } from '../controllers/menu.controller';
import { validate } from '../middlewares/validate.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { requireRole } from '../middlewares/rbac.middleware';
import {
  createCategorySchema,
  updateCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  menuItemAvailabilitySchema,
} from '../validators/menu.validator';
import { UserRole } from '@prisma/client';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Admin routes (authenticated) ──────────────────────────────────────────────
const adminGuard = [authenticate, requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN)];

router.get('/admin/categories', ...adminGuard, menuController.getCategories);
router.get('/admin/items', ...adminGuard, menuController.getAdminMenuItems);
router.post('/admin/items', ...adminGuard, validate(createMenuItemSchema), menuController.createMenuItem);
router.put('/admin/items/:id', ...adminGuard, validate(updateMenuItemSchema), menuController.updateMenuItem);
router.delete('/admin/items/:id', ...adminGuard, menuController.deleteMenuItem);
router.patch('/admin/items/:id/availability', ...adminGuard, validate(menuItemAvailabilitySchema), menuController.setItemAvailability);

router.post('/admin/categories', ...adminGuard, validate(createCategorySchema), menuController.createCategory);
router.put('/admin/categories/:id', ...adminGuard, validate(updateCategorySchema), menuController.updateCategory);
router.delete('/admin/categories/:id', ...adminGuard, menuController.deleteCategory);

router.post('/admin/upload', ...adminGuard, upload.single('image'), menuController.uploadImage);

// ── Public menu routes ────────────────────────────────────────────────────────
router.get('/items/:id', menuController.getMenuItemById);
router.get('/:restaurantId/search', menuController.searchMenu);
router.get('/:restaurantId', menuController.getMenu);

export default router;

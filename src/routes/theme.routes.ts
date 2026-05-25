import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';

const router = Router();

// Public: no auth required — used by the Steward-Menu frontend
// GET /v1/menu/:slug/theme
router.get('/:slug/theme', settingsController.getTheme);

export default router;

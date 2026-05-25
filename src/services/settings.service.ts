import { prisma } from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL } from '../constants';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { Prisma } from '@prisma/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SettingsPatch {
  taxRate?: number;
  serviceCharge?: number;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  fontHeading?: string | null;
  fontBody?: string | null;
  customCss?: string | null;
  // Strictly typed for Prisma JSON columns
  openingHours?: Prisma.InputJsonValue;
  offlineMode?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ensure a RestaurantSettings row exists for the given restaurant.
 * Called on first access to handle restaurants created before the migration.
 */
async function upsertSettings(restaurantId: string) {
  return prisma.restaurantSettings.upsert({
    where: { restaurantId },
    update: {},
    create: { restaurantId },
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

export const settingsService = {
  async getSettings(restaurantId: string) {
    const cacheKey = CACHE_KEYS.settings(restaurantId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Verify restaurant exists
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const settings = await upsertSettings(restaurantId);
    await cacheSet(cacheKey, settings, CACHE_TTL.SETTINGS);
    return settings;
  },

  async updateSettings(restaurantId: string, patch: SettingsPatch) {
    // Verify restaurant exists
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const updated = await prisma.restaurantSettings.upsert({
      where: { restaurantId },
      update: {
        ...patch,
        taxRate: patch.taxRate !== undefined ? patch.taxRate : undefined,
        serviceCharge: patch.serviceCharge !== undefined ? patch.serviceCharge : undefined,
      },
      create: {
        restaurantId,
        ...patch,
      },
    });

    await cacheDel(CACHE_KEYS.settings(restaurantId));
    logger.info('Restaurant settings updated', { restaurantId });
    return updated;
  },

  /**
   * Returns only the theme fields needed by the public menu page.
   * Resolves by restaurant slug or ID.
   */
  async getTheme(slugOrId: string) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: { id: true, name: true, logoUrl: true, currency: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const settings = await upsertSettings(restaurant.id);

    return {
      restaurantId: restaurant.id,
      name: restaurant.name,
      logoUrl: restaurant.logoUrl,
      currency: restaurant.currency,
      offlineMode: settings.offlineMode,
      primaryColor: settings.primaryColor,
      secondaryColor: settings.secondaryColor,
      accentColor: settings.accentColor,
      fontHeading: settings.fontHeading,
      fontBody: settings.fontBody,
      customCss: settings.customCss,
      openingHours: settings.openingHours,
    };
  },

  /**
   * Returns the effective tax rate for a restaurant.
   * Falls back to DEFAULT_TAX_RATE (0.05) so existing code paths are unaffected.
   */
  async getTaxRate(restaurantId: string): Promise<number> {
    try {
      const settings = await prisma.restaurantSettings.findUnique({
        where: { restaurantId },
        select: { taxRate: true },
      });
      if (!settings) return 0.05;
      return Number(settings.taxRate);
    } catch (err) {
      logger.warn('Failed to fetch tax rate, falling back to default', {
        restaurantId,
        error: (err as Error).message,
      });
      return 0.05;
    }
  },
};
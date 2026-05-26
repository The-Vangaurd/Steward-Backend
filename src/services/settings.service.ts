import { prisma } from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL } from '../constants';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { Prisma } from '@prisma/client';
import { cloudinary } from '../config/cloudinary';

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
  openingHours?: Prisma.InputJsonValue;
  offlineMode?: boolean;
  autoAcceptOrders?: boolean;
  estimatedPrepMins?: number;
  offlineModeMessage?: string | null;
  serviceChargeLabel?: string | null;
  notifyOnNewOrder?: boolean;
  notifyOnLowStock?: boolean;
  notifyEmail?: string | null;
  showCalories?: boolean;
  showPrepTime?: boolean;
  showVegBadge?: boolean;
  menuLayout?: string;
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

    const profile = await settingsService.getProfile(restaurantId);
    const settings = await upsertSettings(restaurantId);

    const combined = {
      ...settings,
      name: profile.name,
      tagline: profile.description,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      timezone: profile.timezone,
      currency: profile.currency,
      slug: profile.slug,
      logoUrl: profile.logoUrl,
      bannerUrl: profile.bannerUrl,
    };

    await cacheSet(cacheKey, combined, CACHE_TTL.SETTINGS);
    return combined;
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

  async getProfile(restaurantId: string) {
    const profile = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        description: true,
        phone: true,
        email: true,
        address: true,
        timezone: true,
        currency: true,
        slug: true,
        logoUrl: true,
        bannerUrl: true,
      },
    });
    if (!profile) throw ApiError.notFound('Restaurant not found');
    return profile;
  },

  async updateProfile(restaurantId: string, patch: any) {
    const updated = await prisma.restaurant.update({
      where: { id: restaurantId },
      data: patch,
      select: {
        id: true,
        name: true,
        description: true,
        phone: true,
        email: true,
        address: true,
        timezone: true,
        currency: true,
        slug: true,
        logoUrl: true,
        bannerUrl: true,
      },
    });
    await cacheDel(CACHE_KEYS.settings(restaurantId));
    return updated;
  },

  async uploadAsset(restaurantId: string, fileBuffer: Buffer, mimetype: string, type: 'logo' | 'banner'): Promise<string> {
    const b64 = fileBuffer.toString('base64');
    const dataURI = `data:${mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: `steward/restaurant/${restaurantId}/${type}`,
      resource_type: 'image',
    });

    return result.secure_url;
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
      restaurantName: restaurant.name,
      logoUrl: restaurant.logoUrl,
      currency: restaurant.currency,
      offlineMode: settings.offlineMode,
      colors: {
        primary: settings.primaryColor ?? null,
        accent: settings.accentColor ?? null,
      },
      fontFamily: settings.fontBody ?? settings.fontHeading ?? null,
      customCss: settings.customCss,
      openingHours: settings.openingHours,
      taxRate: Number(settings.taxRate),
      showCalories: settings.showCalories ?? true,
      showPrepTime: settings.showPrepTime ?? true,
      showVegBadge: settings.showVegBadge ?? true,
      menuLayout: (settings.menuLayout as "grid" | "list") ?? "grid",
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
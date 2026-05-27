import { prisma } from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL } from '../constants';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { Prisma } from '@prisma/client';
import { cloudinary, cloudinaryConfigured } from '../config/cloudinary';
import { sanitizeCSS } from '../utils/cssUtils';

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

async function upsertSettings(restaurantId: string) {
  return prisma.restaurantSettings.upsert({
    where: { restaurantId },
    update: {},
    create: { restaurantId },
  });
}

async function findSettings(restaurantId: string) {
  return prisma.restaurantSettings.findUnique({ where: { restaurantId } });
}

/**
 * Build the canonical combined settings object returned by GET /settings.
 * This is the single source of truth for the shape the frontend receives.
 *
 * Field mapping notes:
 * - taxRate / serviceCharge: DB stores decimal fractions (0.05 = 5%),
 *   API returns percentage integers (5), frontend displays percentages.
 * - fontBody / fontHeading: both returned so the frontend normalisation layer
 *   can map to its `fontFamily` field without guessing which column to use.
 * - description: the Restaurant table stores tagline as `description`.
 *   We return it as BOTH `description` AND `tagline` for backward compat.
 *   The frontend normalisation layer maps `description` → `tagline`.
 * - secondaryColor: returned even if null so it is preserved in the cache.
 * - slug: read-only, returned for menu URL construction.
 * - logoUrl / bannerUrl: live on the Restaurant table, not RestaurantSettings.
 */
function buildCombinedSettings(
  profile: {
    id: string;
    name: string;
    description: string | null;
    phone: string | null;
    email: string | null;
    address: Prisma.JsonValue;
    timezone: string;
    currency: string;
    slug: string;
    logoUrl: string | null;
    bannerUrl: string | null;
  },
  settings: {
    taxRate: Prisma.Decimal;
    serviceCharge: Prisma.Decimal;
    primaryColor: string | null;
    secondaryColor: string | null;
    accentColor: string | null;
    fontHeading: string | null;
    fontBody: string | null;
    customCss: string | null;
    openingHours: Prisma.JsonValue;
    offlineMode: boolean;
    autoAcceptOrders: boolean;
    estimatedPrepMins: number;
    offlineModeMessage: string | null;
    serviceChargeLabel: string | null;
    notifyOnNewOrder: boolean;
    notifyOnLowStock: boolean;
    notifyEmail: string | null;
    showCalories: boolean;
    showPrepTime: boolean;
    showVegBadge: boolean;
    menuLayout: string;
  },
) {
  return {
    // ── Settings table fields ──────────────────────────────────────────────
    taxRate: Number(settings.taxRate) * 100,
    serviceCharge: Number(settings.serviceCharge) * 100,
    primaryColor: settings.primaryColor,
    secondaryColor: settings.secondaryColor,
    accentColor: settings.accentColor,
    fontHeading: settings.fontHeading,
    fontBody: settings.fontBody,
    customCss: settings.customCss,
    openingHours: settings.openingHours,
    offlineMode: settings.offlineMode,
    autoAcceptOrders: settings.autoAcceptOrders,
    estimatedPrepMins: settings.estimatedPrepMins,
    offlineModeMessage: settings.offlineModeMessage,
    serviceChargeLabel: settings.serviceChargeLabel,
    notifyOnNewOrder: settings.notifyOnNewOrder,
    notifyOnLowStock: settings.notifyOnLowStock,
    notifyEmail: settings.notifyEmail,
    showCalories: settings.showCalories,
    showPrepTime: settings.showPrepTime,
    showVegBadge: settings.showVegBadge,
    menuLayout: settings.menuLayout,
    // ── Profile / Restaurant table fields ─────────────────────────────────
    name: profile.name,
    // Return as both `description` (raw DB name) and `tagline` (frontend name)
    // The frontend normalisation layer handles the mapping.
    description: profile.description,
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
}

// ── Service ───────────────────────────────────────────────────────────────────

export const settingsService = {
  async getSettings(restaurantId: string) {
  const cacheKey = CACHE_KEYS.settings(restaurantId);
  const cached = await cacheGet(cacheKey);

  if (cached) return cached;

    // PERF: Run profile fetch and settings fetch in parallel (was sequential —
    // getProfile completed before upsertSettings started).
    const [profile, settings] = await Promise.all([
      settingsService.getProfile(restaurantId),
      upsertSettings(restaurantId),
    ]);

    const combined = buildCombinedSettings(profile, settings);

    await cacheSet(cacheKey, combined, CACHE_TTL.SETTINGS);
    return combined;
  },

  async updateSettings(restaurantId: string, patch: SettingsPatch) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    const customCss = patch.customCss ? sanitizeCSS(patch.customCss) : patch.customCss;

    const updated = await prisma.restaurantSettings.upsert({
      where: { restaurantId },
      update: {
        ...patch,
        customCss,
        taxRate: patch.taxRate !== undefined ? patch.taxRate / 100 : undefined,
        serviceCharge: patch.serviceCharge !== undefined ? patch.serviceCharge / 100 : undefined,
      },
      create: {
        ...patch,
        restaurantId,
        customCss,
        taxRate: patch.taxRate !== undefined ? patch.taxRate / 100 : 0.05,
        serviceCharge: patch.serviceCharge !== undefined ? patch.serviceCharge / 100 : 0.00,
      },
    });

    // Invalidate all related caches in parallel
    await Promise.all([
      cacheDel(CACHE_KEYS.settings(restaurantId)),
      cacheDel(CACHE_KEYS.theme(restaurantId)),
      cacheDel(CACHE_KEYS.taxRate(restaurantId)),
    ]);

    logger.info('Restaurant settings updated', { restaurantId });

    // Return the full canonical settings object (not just the settings row)
    // so the PATCH response mirrors GET /settings — this prevents partial
    // overwrites of profile fields in the frontend query cache.
    return settingsService.getSettings(restaurantId);
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

  async updateProfile(restaurantId: string, patch: {
    name?: string;
    description?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: unknown;
    timezone?: string;
    currency?: string;
    logoUrl?: string | null;
    bannerUrl?: string | null;
  }) {
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

    await Promise.all([
      cacheDel(CACHE_KEYS.settings(restaurantId)),
      cacheDel(CACHE_KEYS.theme(restaurantId)),
    ]);

    // Return the full combined settings so the PATCH /settings/profile response
    // includes branding/operations fields. This prevents the frontend from
    // temporarily losing non-profile values after a profile save.
    return settingsService.getSettings(restaurantId);
  },

  async uploadAsset(
    restaurantId: string,
    fileBuffer: Buffer,
    mimetype: string,
    type: 'logo' | 'banner',
  ): Promise<string> {
    if (!cloudinaryConfigured) {
      throw ApiError.serviceUnavailable(
        'Image uploads are not available. The server is not configured with Cloudinary credentials. ' +
        'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      );
    }

    const b64 = fileBuffer.toString('base64');
    const dataURI = `data:${mimetype};base64,${b64}`;

    try {
      const result = await cloudinary.uploader.upload(dataURI, {
        folder: `steward/restaurant/${restaurantId}/${type}`,
        resource_type: 'image',
      });
      return result.secure_url;
    } catch (err) {
      logger.error('Cloudinary upload failed', {
        restaurantId,
        type,
        error: (err as Error).message,
      });
      throw ApiError.internal('Image upload failed. Please try again.');
    }
  },

  async getTheme(slugOrId: string) {
    const { CACHE_KEYS: CK, CACHE_TTL: CT } = await import('../constants');
    const slugCacheKey = CK.slug(slugOrId);
    let restaurantId = await cacheGet<string>(slugCacheKey);

    let restaurantRow: {
      id: string;
      name: string;
      logoUrl: string | null;
      currency: string;
    } | null = null;

    if (!restaurantId) {
      restaurantRow = await prisma.restaurant.findFirst({
        where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
        select: { id: true, name: true, logoUrl: true, currency: true },
      });
      if (!restaurantRow) throw ApiError.notFound('Restaurant not found');
      restaurantId = restaurantRow.id;
      await cacheSet(slugCacheKey, restaurantId, CACHE_TTL.SLUG);
    }

    const themeCacheKey = CACHE_KEYS.theme(restaurantId);
    const cachedTheme = await cacheGet(themeCacheKey);
    if (cachedTheme) return cachedTheme;

    if (!restaurantRow) {
      restaurantRow = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true, logoUrl: true, currency: true },
      });
      if (!restaurantRow) throw ApiError.notFound('Restaurant not found');
    }

    const settings = await findSettings(restaurantId);

    const theme = {
      restaurantId: restaurantRow.id,
      restaurantName: restaurantRow.name,
      logoUrl: restaurantRow.logoUrl,
      currency: restaurantRow.currency,
      offlineMode: settings?.offlineMode ?? false,
      colors: {
        primary: settings?.primaryColor ?? null,
        secondary: settings?.secondaryColor ?? null,
        accent: settings?.accentColor ?? null,
      },
      fontFamily: settings?.fontBody ?? settings?.fontHeading ?? null,
      customCss: settings?.customCss ?? null,
      openingHours: settings?.openingHours ?? null,
      taxRate: settings ? Number(settings.taxRate) : 0.05,
      showCalories: settings?.showCalories ?? true,
      showPrepTime: settings?.showPrepTime ?? true,
      showVegBadge: settings?.showVegBadge ?? true,
      menuLayout: (settings?.menuLayout as 'grid' | 'list') ?? 'grid',
    };

    await cacheSet(themeCacheKey, theme, CT.THEME);
    return theme;
  },

  async getTaxRate(restaurantId: string): Promise<number> {
    const cacheKey = CACHE_KEYS.taxRate(restaurantId);
    const cached = await cacheGet<number>(cacheKey);
    if (cached !== null) return cached;

    try {
      const settings = await prisma.restaurantSettings.findUnique({
        where: { restaurantId },
        select: { taxRate: true },
      });
      const rate = settings ? Number(settings.taxRate) : 0.05;
      await cacheSet(cacheKey, rate, CACHE_TTL.TAX_RATE);
      return rate;
    } catch (err) {
      logger.warn('Failed to fetch tax rate, falling back to default', {
        restaurantId,
        error: (err as Error).message,
      });
      return 0.05;
    }
  },
};

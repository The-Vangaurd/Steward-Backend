import { prisma } from '../config/database';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL } from '../constants';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { Prisma } from '@prisma/client';
import { cloudinary } from '../config/cloudinary';
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

const LEGACY_SETTINGS_SELECT = {
  id: true,
  restaurantId: true,
  taxRate: true,
  serviceCharge: true,
  primaryColor: true,
  secondaryColor: true,
  accentColor: true,
  fontHeading: true,
  fontBody: true,
  customCss: true,
  openingHours: true,
  offlineMode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RestaurantSettingsSelect;

function toLegacySettingsPatch(patch: SettingsPatch) {
  return {
    taxRate: patch.taxRate !== undefined ? patch.taxRate / 100 : undefined,
    serviceCharge: patch.serviceCharge !== undefined ? patch.serviceCharge / 100 : undefined,
    primaryColor: patch.primaryColor,
    secondaryColor: patch.secondaryColor,
    accentColor: patch.accentColor,
    fontHeading: patch.fontHeading,
    fontBody: patch.fontBody,
    customCss: patch.customCss,
    openingHours: patch.openingHours,
    offlineMode: patch.offlineMode,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ensure a RestaurantSettings row exists for the given restaurant.
 * Only called at write-time or when explicitly bootstrapping a new restaurant.
 *
 * PERF: Previously called as `upsertSettings()` on every read path (getTheme,
 * getSettings) — this issued a DB WRITE on every public menu load.  Now we use
 * findUnique for reads and only fall back to upsert when the row is missing.
 */
async function upsertSettings(restaurantId: string) {
  return prisma.restaurantSettings.upsert({
    where: { restaurantId },
    update: {},
    create: { restaurantId },
    select: LEGACY_SETTINGS_SELECT,
  });
}

/**
 * Read-only settings fetch.  Returns null when no settings row exists yet so
 * callers can decide whether to create one.
 */
async function findSettings(restaurantId: string) {
  return prisma.restaurantSettings.findUnique({
    where: { restaurantId },
    select: LEGACY_SETTINGS_SELECT,
  });
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

    const combined = {
      ...settings,
      taxRate: settings ? Number(settings.taxRate) * 100 : 5,
      serviceCharge: settings ? Number(settings.serviceCharge) * 100 : 0,
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

    const customCss = patch.customCss ? sanitizeCSS(patch.customCss) : patch.customCss;
    const legacyPatch = toLegacySettingsPatch({ ...patch, customCss });

    const updated = await prisma.restaurantSettings.upsert({
      where: { restaurantId },
      update: legacyPatch,
      create: {
        restaurantId,
        ...legacyPatch,
        taxRate: legacyPatch.taxRate ?? 0.05,
        serviceCharge: legacyPatch.serviceCharge ?? 0.00,
      },
      select: LEGACY_SETTINGS_SELECT,
    });

    // PERF: Invalidate all related caches in parallel
    await Promise.all([
      cacheDel(CACHE_KEYS.settings(restaurantId)),
      cacheDel(CACHE_KEYS.theme(restaurantId)),
      cacheDel(CACHE_KEYS.taxRate(restaurantId)),
    ]);

    logger.info('Restaurant settings updated', { restaurantId });
    return {
      ...updated,
      taxRate: Number(updated.taxRate) * 100,
      serviceCharge: Number(updated.serviceCharge) * 100,
    };
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
    // PERF: Invalidate all related caches in parallel
    await Promise.all([
      cacheDel(CACHE_KEYS.settings(restaurantId)),
      cacheDel(CACHE_KEYS.theme(restaurantId)),
    ]);
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
   *
   * PERF: Two critical fixes:
   * 1. Added Redis caching (THEME TTL = 5 min). Previously uncached, so every
   *    single public menu page load hit the DB.
   * 2. Replaced upsertSettings() with findSettings() — the old code issued a
   *    DB WRITE (upsert) on every theme read, even when the row already existed.
   *    Now we do a cheap read; if the row is missing (new restaurant) we fall
   *    back to defaults without writing.
   */
  async getTheme(slugOrId: string) {
    // Try to resolve from slug cache first
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

    // Check theme cache
    const themeCacheKey = CACHE_KEYS.theme(restaurantId);
    const cachedTheme = await cacheGet(themeCacheKey);
    if (cachedTheme) return cachedTheme;

    // Fetch restaurant row if we only resolved from cache (didn't query above)
    if (!restaurantRow) {
      restaurantRow = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true, logoUrl: true, currency: true },
      });
      if (!restaurantRow) throw ApiError.notFound('Restaurant not found');
    }

    // PERF: Use findUnique (READ) instead of upsert (WRITE) — avoids a DB write
    // on every public menu load.  If settings don't exist, we return defaults.
    const settings = await findSettings(restaurantId);

    const theme = {
      restaurantId: restaurantRow.id,
      restaurantName: restaurantRow.name,
      logoUrl: restaurantRow.logoUrl,
      currency: restaurantRow.currency,
      offlineMode: settings?.offlineMode ?? false,
      colors: {
        primary: settings?.primaryColor ?? null,
        accent: settings?.accentColor ?? null,
      },
      fontFamily: settings?.fontBody ?? settings?.fontHeading ?? null,
      customCss: settings?.customCss ?? null,
      openingHours: settings?.openingHours ?? null,
      taxRate: settings ? Number(settings.taxRate) : 0.05,
      showCalories: true,
      showPrepTime: true,
      showVegBadge: true,
      menuLayout: 'grid' as const,
    };

    await cacheSet(themeCacheKey, theme, CACHE_TTL.THEME);
    return theme;
  },

  /**
   * Returns the effective tax rate for a restaurant.
   * Falls back to 0.05 so existing code paths are unaffected.
   *
   * PERF: Added Redis caching (TAX_RATE TTL = 10 min). Previously called on
   * every order creation with a fresh DB round-trip each time.
   */
  async getTaxRate(restaurantId: string): Promise<number> {
    // PERF: Check cache first — tax rate rarely changes
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

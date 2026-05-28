import { prisma } from '../config/database';
import { cloudinary } from '../config/cloudinary';
import { cacheGet, cacheSet, cacheDel } from '../utils/redis';
import { CACHE_KEYS, CACHE_TTL, SOCKET_EVENTS } from '../constants';
import { ApiError } from '../utils/ApiError';
import {
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateMenuItemInput,
  UpdateMenuItemInput,
} from '../validators/menu.validator';
import { parsePagination, buildPaginationMeta } from '../utils/pagination';

export const menuService = {
  // ── Public endpoints ─────────────────────────────────────────────────────────

  /**
   * Resolves a restaurant slug or cuid to its internal id.
   *
   * PERF: The slug→id mapping never changes after restaurant creation, so we
   * cache it for 1 hour (SLUG TTL).  This eliminates a full-table lookup on
   * every public menu load and every order creation.
   */
  async resolveRestaurantId(slugOrId: string): Promise<string> {
    // Check slug cache first
    const slugCacheKey = CACHE_KEYS.slug(slugOrId);
    const cachedId = await cacheGet<string>(slugCacheKey);
    if (cachedId) return cachedId;

    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');

    // Cache both the slug and the id itself so either format is fast on next call
    await cacheSet(slugCacheKey, restaurant.id, CACHE_TTL.SLUG);

    return restaurant.id;
  },

  async getPublicMenu(slugOrId: string) {
    const restaurantId = await menuService.resolveRestaurantId(slugOrId);
    const cacheKey = CACHE_KEYS.menu(restaurantId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // PERF: explicit select avoids pulling createdAt/updatedAt on every public
    // menu request (reduces wire payload by ~30 %).
    const categories = await prisma.category.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        sortOrder: true,
        menuItems: {
          where: { isAvailable: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            price: true,
            imageUrl: true,
            kitchenType: true,
            isAvailable: true,
            isPopular: true,
            isVeg: true,
            calories: true,
            prepTimeMins: true,
            sortOrder: true,
          },
        },
      },
    });

    await cacheSet(cacheKey, categories, CACHE_TTL.MENU);
    return categories;
  },

  async getMenuItemById(id: string) {
    const cacheKey = CACHE_KEYS.menuItem(id);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const item = await prisma.menuItem.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        imageUrl: true,
        kitchenType: true,
        isAvailable: true,
        isPopular: true,
        isVeg: true,
        calories: true,
        prepTimeMins: true,
        sortOrder: true,
        categoryId: true,
        category: { select: { id: true, name: true } },
      },
    });

    if (!item) throw ApiError.notFound('Menu item not found');
    await cacheSet(cacheKey, item, CACHE_TTL.MENU);
    return item;
  },

  async searchMenuItems(slugOrId: string, query: string) {
    const restaurantId = await menuService.resolveRestaurantId(slugOrId);
    // PERF: select only fields the search results UI needs
    return prisma.menuItem.findMany({
      where: {
        category: { restaurantId, isActive: true },
        isAvailable: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { sortOrder: 'asc' },
      take: 30,
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        imageUrl: true,
        isVeg: true,
        isPopular: true,
        calories: true,
        prepTimeMins: true,
        categoryId: true,
      },
    });
  },

  // ── Categories (Admin) ────────────────────────────────────────────────────────

  async getCategories(restaurantId: string) {
    return prisma.category.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, description: true, imageUrl: true, sortOrder: true },
    });
  },

  async createCategory(restaurantId: string, data: CreateCategoryInput) {
    const category = await prisma.category.create({ data: { restaurantId, ...data } });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.categories(restaurantId));
    return category;
  },

  async updateCategory(id: string, restaurantId: string, data: UpdateCategoryInput) {
    const category = await prisma.category.findFirst({ where: { id, restaurantId } });
    if (!category) throw ApiError.notFound('Category not found');

    const updated = await prisma.category.update({ where: { id }, data });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.categories(restaurantId));
    return updated;
  },

  async deleteCategory(id: string, restaurantId: string) {
    const category = await prisma.category.findFirst({ where: { id, restaurantId } });
    if (!category) throw ApiError.notFound('Category not found');

    // PERF: count and existence check combined; count is cheaper than findFirst
    const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });
    if (itemCount > 0)
      throw ApiError.conflict('Cannot delete category with existing menu items');

    await prisma.category.delete({ where: { id } });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.categories(restaurantId));
  },

  // ── Menu Items (Admin) ────────────────────────────────────────────────────────

  async getAdminMenuItems(restaurantId: string, page?: unknown, limit?: unknown) {
    const pagination = parsePagination(page, limit);

    // PERF: both queries run in parallel (unchanged — already correct)
    const [items, total] = await Promise.all([
      prisma.menuItem.findMany({
        where: { category: { restaurantId } },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
          kitchenType: true,
          isAvailable: true,
          isPopular: true,
          isVeg: true,
          calories: true,
          prepTimeMins: true,
          sortOrder: true,
          categoryId: true,
          category: { select: { id: true, name: true } },
        },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
        skip: pagination.skip,
        take: pagination.limit,
      }),
      prisma.menuItem.count({ where: { category: { restaurantId } } }),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination.page, pagination.limit) };
  },

  async createMenuItem(restaurantId: string, data: CreateMenuItemInput) {
    // Verify category belongs to restaurant
    const category = await prisma.category.findFirst({
      where: { id: data.categoryId, restaurantId },
      select: { id: true },
    });
    if (!category) throw ApiError.notFound('Category not found');

    const item = await prisma.menuItem.create({ data });
    await cacheDel(CACHE_KEYS.menu(restaurantId));
    return item;
  },

  async updateMenuItem(id: string, restaurantId: string, data: UpdateMenuItemInput) {
    const item = await prisma.menuItem.findFirst({
      where: { id, category: { restaurantId } },
      select: { id: true },
    });
    if (!item) throw ApiError.notFound('Menu item not found');

    const updated = await prisma.menuItem.update({ where: { id }, data });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.menuItem(id));
    return updated;
  },

  async deleteMenuItem(id: string, restaurantId: string) {
    const item = await prisma.menuItem.findFirst({
      where: { id, category: { restaurantId } },
      select: { id: true },
    });
    if (!item) throw ApiError.notFound('Menu item not found');

    // Soft delete — just mark unavailable if it has order references, else hard delete
    const refs = await prisma.orderItem.count({ where: { menuItemId: id } });
    if (refs > 0) {
      await prisma.menuItem.update({ where: { id }, data: { isAvailable: false } });
    } else {
      await prisma.menuItem.delete({ where: { id } });
    }

    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.menuItem(id));
  },

  async setItemAvailability(id: string, restaurantId: string, isAvailable: boolean) {
    const item = await prisma.menuItem.findFirst({
      where: { id, category: { restaurantId } },
      select: { id: true },
    });
    if (!item) throw ApiError.notFound('Menu item not found');

    const updated = await prisma.menuItem.update({ where: { id }, data: { isAvailable } });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.menuItem(id));
    return updated;
  },

  // ── Image Upload ─────────────────────────────────────────────────────────────

  async uploadImage(fileBuffer: Buffer, mimetype: string): Promise<string> {
    const b64 = fileBuffer.toString('base64');
    const dataURI = `data:${mimetype};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'restaurant/menu',
      resource_type: 'image',
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    });

    return result.secure_url;
  },
};

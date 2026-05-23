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

  // Helper used by public endpoints to resolve slug OR cuid to a real restaurant id
  async resolveRestaurantId(slugOrId: string): Promise<string> {
    const restaurant = await prisma.restaurant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], isActive: true },
      select: { id: true },
    });
    if (!restaurant) throw ApiError.notFound('Restaurant not found');
    return restaurant.id;
  },

  async getPublicMenu(slugOrId: string) {
    const restaurantId = await menuService.resolveRestaurantId(slugOrId);
    const cacheKey = CACHE_KEYS.menu(restaurantId);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const categories = await prisma.category.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        menuItems: {
          where: { isAvailable: true },
          orderBy: { sortOrder: 'asc' },
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
      include: { category: { select: { id: true, name: true } } },
    });

    if (!item) throw ApiError.notFound('Menu item not found');
    await cacheSet(cacheKey, item, CACHE_TTL.MENU);
    return item;
  },

  async searchMenuItems(slugOrId: string, query: string) {
    const restaurantId = await menuService.resolveRestaurantId(slugOrId);
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

    const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });
    if (itemCount > 0)
      throw ApiError.conflict('Cannot delete category with existing menu items');

    await prisma.category.delete({ where: { id } });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.categories(restaurantId));
  },

  // ── Menu Items (Admin) ────────────────────────────────────────────────────────

  async getAdminMenuItems(restaurantId: string, page?: unknown, limit?: unknown) {
    const pagination = parsePagination(page, limit);

    const [items, total] = await Promise.all([
      prisma.menuItem.findMany({
        where: { category: { restaurantId } },
        include: { category: { select: { id: true, name: true } } },
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
    });
    if (!category) throw ApiError.notFound('Category not found');

    const item = await prisma.menuItem.create({ data });
    await cacheDel(CACHE_KEYS.menu(restaurantId));
    return item;
  },

  async updateMenuItem(id: string, restaurantId: string, data: UpdateMenuItemInput) {
    const item = await prisma.menuItem.findFirst({
      where: { id, category: { restaurantId } },
    });
    if (!item) throw ApiError.notFound('Menu item not found');

    const updated = await prisma.menuItem.update({ where: { id }, data });
    await cacheDel(CACHE_KEYS.menu(restaurantId), CACHE_KEYS.menuItem(id));
    return updated;
  },

  async deleteMenuItem(id: string, restaurantId: string) {
    const item = await prisma.menuItem.findFirst({
      where: { id, category: { restaurantId } },
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

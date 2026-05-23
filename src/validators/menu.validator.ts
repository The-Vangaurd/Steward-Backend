import { z } from 'zod';
import { KitchenType } from '@prisma/client';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().min(0).default(0),
});

export const updateCategorySchema = createCategorySchema.partial();

export const createMenuItemSchema = z.object({
  categoryId: z.string().cuid(),
  name: z.string().min(1).max(150),
  description: z.string().max(1000).optional(),
  price: z.number().positive(),
  imageUrl: z.string().url().optional(),
  kitchenType: z.nativeEnum(KitchenType).default(KitchenType.MAIN),
  isAvailable: z.boolean().default(true),
  isPopular: z.boolean().default(false),
  isVeg: z.boolean().default(true),
  calories: z.number().int().positive().optional(),
  prepTimeMins: z.number().int().min(1).max(180).default(15),
  sortOrder: z.number().int().min(0).default(0),
});

export const updateMenuItemSchema = createMenuItemSchema.partial().omit({ categoryId: true });

export const menuItemAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
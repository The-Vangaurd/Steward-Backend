import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number'),
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  phone: z.string().optional(),
  role: z.enum(['KITCHEN_STAFF', 'WAITER']).default('KITCHEN_STAFF'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

// ─── Owner Registration ───────────────────────────────────────────────────────
// password is optional when oauthToken is present (Google OAuth registration)

export const ownerRegisterSchema = z.object({
  restaurantName: z.string().min(2, 'Restaurant name must be at least 2 characters').max(255),
  ownerName: z.string().min(2, 'Owner name must be at least 2 characters').max(100),
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number')
    .optional(),
  phone: z.string().min(0).max(20).optional().default(''),
  /** Passed by the Google OAuth restaurant-setup page — skips password requirement. */
  oauthToken: z.string().optional(),
});

// ─── Staff PIN Login ──────────────────────────────────────────────────────────

export const staffLoginSchema = z.object({
  /** The 6-character alphanumeric code printed on the restaurant's tablet setup card. */
  restaurantCode: z
    .string()
    .min(3, 'Restaurant code is required')
    .max(20)
    .toUpperCase(),
  /** Exactly 4 numeric digits. Stored as bcrypt hash — never logged or returned. */
  pin: z
    .string()
    .length(4, 'PIN must be exactly 4 digits')
    .regex(/^\d{4}$/, 'PIN must contain only digits'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string()
    .min(8, 'Must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type OwnerRegisterInput = z.infer<typeof ownerRegisterSchema>;
export type StaffLoginInput = z.infer<typeof staffLoginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

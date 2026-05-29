import { z } from 'zod';

// ── Placeholder detection helpers ─────────────────────────────────────────────

const PLACEHOLDER_JWT_SECRETS = [
  'your-super-secret-jwt-key-minimum-32-characters',
  'your-super-secret-refresh-key-minimum-32-characters',
];

const PLACEHOLDER_REDIS_PATTERNS = [
  'REPLACE_WITH_ACTUAL_PASSWORD',
  'YOUR_PASSWORD_HERE',
  'CHANGE_ME',
];

function isPlaceholderRedisUrl(url: string): boolean {
  return PLACEHOLDER_REDIS_PATTERNS.some((p) => url.includes(p));
}

// ── Schema ────────────────────────────────────────────────────────────────────

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(4000),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .url({ message: 'DATABASE_URL must be a valid database URL' }),

  // ── Redis (OPTIONAL) ──────────────────────────────────────────────────────
  // Using plain string because rediss:// TLS URLs may fail strict .url()
  // validation in certain ioredis environments.
  REDIS_URL: z.string().optional(),

  // ── JWT ───────────────────────────────────────────────────────────────────
  JWT_SECRET: z
    .string()
    .min(32, { message: 'JWT_SECRET must be at least 32 characters' }),

  JWT_REFRESH_SECRET: z
    .string()
    .min(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' }),

  JWT_GUEST_SECRET: z
    .string()
    .min(32, { message: 'JWT_GUEST_SECRET must be at least 32 characters' })
    .default('guest-secret-for-development-only-minimum-32-chars'),

  JWT_EXPIRES_IN: z.string().default('15m'),

  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // ── CORS ──────────────────────────────────────────────────────────────────
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000'),

  // ── Optional Cloudinary ───────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // ── Optional Email ────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),

  FROM_EMAIL: z
    .string()
    .email({ message: 'FROM_EMAIL must be a valid email address' })
    .optional(),

  // ── Optional Observability ────────────────────────────────────────────────
  SENTRY_DSN: z
    .string()
    .url({ message: 'SENTRY_DSN must be a valid URL' })
    .optional(),

  SMS_PROVIDER_API_KEY: z.string().optional(),

  ANALYTICS_WRITE_KEY: z.string().optional(),

  // ── Rate Limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),

  RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const data = parsed.data;

// ── Production secret validation ──────────────────────────────────────────────

if (data.NODE_ENV === 'production') {
  if (PLACEHOLDER_JWT_SECRETS.includes(data.JWT_SECRET)) {
    console.error(
      '❌ JWT_SECRET is still using the placeholder value. Set a real secret before deploying.',
    );
    process.exit(1);
  }

  if (PLACEHOLDER_JWT_SECRETS.includes(data.JWT_REFRESH_SECRET)) {
    console.error(
      '❌ JWT_REFRESH_SECRET is still using the placeholder value. Set a real secret before deploying.',
    );
    process.exit(1);
  }

  // Prevent localhost/dev origins from reaching production. If CORS_ORIGINS
  // is not set in Render's environment variables it defaults to localhost,
  // and every API call from the production Vercel frontend will be rejected.
  const allLocalhostOrEmpty =
    !data.CORS_ORIGINS ||
    data.CORS_ORIGINS
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .every((o) => !o || o.includes('localhost') || o.includes('127.0.0.1'));

  if (allLocalhostOrEmpty) {
    console.error(
      '❌ CORS_ORIGINS is not configured for production.\n' +
      'Current value: ' + (data.CORS_ORIGINS || '(empty)') + '\n' +
      'Set it in Render → Environment Variables to your real frontend URLs, e.g.:\n' +
      '   CORS_ORIGINS=https://your-admin.vercel.app,https://your-menu.vercel.app\n' +
      'Without this every cross-origin API request from the frontend is rejected.',
    );
    process.exit(1);
  }
}

// ── Redis placeholder detection ───────────────────────────────────────────────
// If REDIS_URL contains a placeholder password the connection will always fail.
// We detect this at startup so the error is clear ("placeholder credential")
// rather than a confusing Redis auth error at runtime.

if (data.REDIS_URL && isPlaceholderRedisUrl(data.REDIS_URL)) {
  console.warn(
    '⚠️  REDIS_URL contains a placeholder password. ' +
    'Redis will be DISABLED until a real credential is provided. ' +
    'The application will run without caching — this is safe but slower.',
  );
  // Clear the URL so the Redis client treats it as "Redis not configured"
  // rather than attempting a connection that will always fail with WRONGPASS.
  data.REDIS_URL = undefined;
}

// ── Cloudinary availability flag ──────────────────────────────────────────────
// Derived at startup so the rest of the app can check a single flag instead of
// testing all three vars individually.
export const cloudinaryConfigured =
  !!data.CLOUDINARY_CLOUD_NAME &&
  !!data.CLOUDINARY_API_KEY &&
  !!data.CLOUDINARY_API_SECRET;

if (!cloudinaryConfigured) {
  console.warn(
    '⚠️  Cloudinary not configured ' +
    '(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET missing). ' +
    'Logo and banner uploads will be disabled.',
  );
}

export const env = data;

export type Env = z.infer<typeof envSchema>;

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Database
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid database URL' }),

  // Redis
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid Redis URL' }).optional(),

  // JWT
  JWT_SECRET: z.string().min(32, { message: 'JWT_SECRET must be at least 32 characters' }),
  JWT_REFRESH_SECRET: z.string().min(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' }),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // CORS — comma-separated origins
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // Optional Cloudinary integration
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Optional email integration
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().email({ message: 'FROM_EMAIL must be a valid email address' }).optional(),

  // Optional observability and messaging
  SENTRY_DSN: z.string().url({ message: 'SENTRY_DSN must be a valid URL' }).optional(),
  SMS_PROVIDER_API_KEY: z.string().optional(),
  ANALYTICS_WRITE_KEY: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const PLACEHOLDER_SECRETS = [
  'your-super-secret-jwt-key-minimum-32-characters',
  'your-super-secret-refresh-key-minimum-32-characters',
];

const data = parsed.data;
if (data.NODE_ENV === 'production') {
  if (PLACEHOLDER_SECRETS.includes(data.JWT_SECRET)) {
    console.error('❌ JWT_SECRET is still using the placeholder value. Set a real secret before deploying.');
    process.exit(1);
  }
  if (PLACEHOLDER_SECRETS.includes(data.JWT_REFRESH_SECRET)) {
    console.error('❌ JWT_REFRESH_SECRET is still using the placeholder value. Set a real secret before deploying.');
    process.exit(1);
  }
}

export const env = data;
export type Env = z.infer<typeof envSchema>;
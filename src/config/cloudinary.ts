import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';
import { ApiError } from '../utils/ApiError';

// ── Configuration ─────────────────────────────────────────────────────────────

const CLOUDINARY_CONFIGURED =
  Boolean(env.CLOUDINARY_CLOUD_NAME) &&
  Boolean(env.CLOUDINARY_API_KEY) &&
  Boolean(env.CLOUDINARY_API_SECRET);

if (CLOUDINARY_CONFIGURED) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME!,
    api_key: env.CLOUDINARY_API_KEY!,
    api_secret: env.CLOUDINARY_API_SECRET!,
    secure: true,
  });
} else {
  // Warn at startup so operators notice immediately — but do NOT crash.
  // Upload endpoints will return a clean 503 instead of an obscure Cloudinary SDK error.
  console.warn(
    '[cloudinary] One or more credentials are missing ' +
    '(CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET). ' +
    'Image upload endpoints will return 503 until credentials are configured.',
  );
}

// ── Guard helper ──────────────────────────────────────────────────────────────

/**
 * Call this at the top of any controller / service method that needs Cloudinary.
 *
 * Throws a 503 ApiError with a machine-readable code so the client can show
 * a meaningful message ("Image uploads are temporarily unavailable") rather
 * than an unhandled SDK crash.
 *
 * @example
 * export const uploadMenuImage = asyncHandler(async (req, res) => {
 *   assertCloudinaryConfigured();
 *   const result = await cloudinary.uploader.upload(req.file.path);
 *   ...
 * });
 */
export function assertCloudinaryConfigured(): void {
  if (!CLOUDINARY_CONFIGURED) {
    throw ApiError.serviceUnavailable(
      'Image upload service is not configured. Please contact support.',
      'CLOUDINARY_NOT_CONFIGURED',
    );
  }
}

export { cloudinary, CLOUDINARY_CONFIGURED };

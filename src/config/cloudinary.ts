import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Re-export cloudinaryConfigured from env so that any file importing from
// this module also gets the flag (avoids import-path mistakes).
export { cloudinaryConfigured } from './env';
export { cloudinary };

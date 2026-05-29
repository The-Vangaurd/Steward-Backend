import crypto from 'crypto';
import { env } from '../config/env';

export function signGuestId(guestId: string): string {
  return crypto.createHmac('sha256', env.JWT_GUEST_SECRET).update(guestId).digest('hex');
}

export function verifySignedGuestId(guestId: string, signature: string): boolean {
  if (!guestId || !signature) return false;
  try {
    const expected = signGuestId(guestId);
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

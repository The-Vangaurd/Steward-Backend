import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload, AuthenticatedUser } from '../types';
import { ApiError } from './ApiError';

export const signAccessToken = (user: AuthenticatedUser): string => {
  const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    role: user.role,
    restaurantId: user.restaurantId,
  };

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
};

export const signRefreshToken = (userId: string): string => {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): JwtPayload => {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'TOKEN_INVALID');
  }
};

// Safe verifier used by non-HTTP contexts (WS handshake) where caller
// wants to distinguish expired tokens from invalid tokens without
// immediately throwing an exception that crashes connection handling.
export const verifyAccessTokenSafe = (token: string): { payload?: JwtPayload; expired?: boolean } => {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    return { payload };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // return decoded payload when available to support reconnect flows
      const decoded = jwt.decode(token) as JwtPayload | null;
      return { payload: decoded ?? undefined, expired: true };
    }
    return {};
  }
};

export const verifyRefreshToken = (token: string): { sub: string } => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string };
  } catch {
    throw ApiError.unauthorized('Invalid refresh token', 'TOKEN_INVALID');
  }
};

// ── Guest order recall tokens ─────────────────────────────────────────────────

export interface GuestTokenPayload {
  orderId: string;
  guestId: string;
  restaurantSlug: string;
}

const guestSecret = (): string => {
  // Fall back to JWT_SECRET if JWT_GUEST_SECRET is not configured.
  return env.JWT_GUEST_SECRET ?? env.JWT_SECRET;
};

export const signGuestToken = (payload: GuestTokenPayload): string => {
  return jwt.sign(payload, guestSecret(), { expiresIn: '30d' } as jwt.SignOptions);
};

export const verifyGuestToken = (token: string): GuestTokenPayload => {
  try {
    return jwt.verify(token, guestSecret()) as GuestTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Guest recall token has expired', 'GUEST_TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid guest recall token', 'GUEST_TOKEN_INVALID');
  }
};
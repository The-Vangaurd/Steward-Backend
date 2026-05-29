import { Router, Request, Response } from 'express';
import { oauthService } from '../services/oauth.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/response';
import { HTTP_STATUS } from '../constants';
import { ApiError } from '../utils/ApiError';
import { getCookieOptions } from '../controllers/auth.controller';
import { redis } from '../config/redis';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const router = Router();

// ── In-Memory Cache Fallback for Oauth Exchange Codes (if Redis is disabled) ──
const memoryCache = new Map<string, { value: string; expiry: number }>();

async function getOauthCode(key: string): Promise<string | null> {
    if (redis) {
        try {
            return await redis.get(key);
        } catch (err) {
            logger.warn('Redis get failed for OAuth exchange, using memory fallback', { error: (err as Error).message });
        }
    }
    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
        memoryCache.delete(key);
        return null;
    }
    return item.value;
}

async function setOauthCode(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (redis) {
        try {
            await redis.set(key, value, 'EX', ttlSeconds);
            return;
        } catch (err) {
            logger.warn('Redis set failed for OAuth exchange, using memory fallback', { error: (err as Error).message });
        }
    }
    memoryCache.set(key, {
        value,
        expiry: Date.now() + ttlSeconds * 1000,
    });
}

async function delOauthCode(key: string): Promise<void> {
    if (redis) {
        try {
            await redis.del(key);
            return;
        } catch (err) {
            logger.warn('Redis del failed for OAuth exchange, using memory fallback', { error: (err as Error).message });
        }
    }
    memoryCache.delete(key);
}

// ── Lazy-load passport to avoid startup crash if GOOGLE_CLIENT_ID is missing ──

let passportInitialised = false;
let passportInstance: any = null;

function getPassport() {
    if (!passportInitialised) {
        const googleClientId = process.env.GOOGLE_CLIENT_ID;
        const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const callbackUrl = process.env.GOOGLE_CALLBACK_URL
            ?? `${process.env.BACKEND_URL ?? 'http://localhost:4000'}/v1/auth/google/callback`;

        if (!googleClientId || !googleClientSecret) {
            logger.warn('Google OAuth disabled — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
            passportInitialised = true;
            return null;
        }

        try {
            const passport = require('passport');
            const GoogleStrategy = require('passport-google-oauth20').Strategy;

            passport.use(
                new GoogleStrategy(
                    {
                        clientID: googleClientId,
                        clientSecret: googleClientSecret,
                        callbackURL: callbackUrl,
                        // passReqToCallback lets us read state from the request
                        passReqToCallback: true,
                    },
                    async (req: Request, _accessToken: string, _refreshToken: string, profile: any, done: Function) => {
                        try {
                            // Decode state param (set in /google handler) to recover role/intent
                            let opts: { role?: string; intent?: string; nonce?: string } = {};
                            try {
                                if (req.query.state) {
                                    opts = JSON.parse(
                                        Buffer.from(req.query.state as string, 'base64url').toString('utf8'),
                                    );
                                }
                            } catch {
                                // Malformed state — proceed with defaults
                            }

                            // ── CSRF Nonce Validation ─────────────────────────────────
                            const cookieNonce = req.cookies?.['oauth_nonce'];
                            if (!opts.nonce || !cookieNonce || opts.nonce !== cookieNonce) {
                                return done(new Error('OAuth CSRF verification failed'), null);
                            }

                            const result = await oauthService.findOrCreateGoogleUser(profile, opts);
                            done(null, result);
                        } catch (err) {
                            done(err, null);
                        }
                    },
                ),
            );

            passportInstance = passport;
        } catch (e) {
            logger.warn('passport-google-oauth20 not installed — Google OAuth disabled');
        }

        passportInitialised = true;
    }

    return passportInstance;
}

/**
 * GET /v1/auth/google
 * Initiates Google OAuth flow.
 */
router.get(
    '/google',
    (req: Request, res: Response, next: Function) => {
        const passport = getPassport();
        if (!passport) {
            res.status(503).json({
                success: false,
                error: {
                    code: 'OAUTH_DISABLED',
                    message: 'Google OAuth is not configured on this server',
                },
            });
            return;
        }

        // Generate CSRF nonce
        const nonce = crypto.randomBytes(32).toString('hex');
        res.cookie('oauth_nonce', nonce, {
            httpOnly: true,
            secure: env.NODE_ENV === 'production',
            sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 5 * 60 * 1000, // 5 minutes
        });

        // Encode role/intent/nonce into state so we can recover them in the callback
        const statePayload: Record<string, string> = { nonce };
        if (req.query.role)   statePayload.role   = req.query.role as string;
        if (req.query.intent) statePayload.intent = req.query.intent as string;

        const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

        passport.authenticate('google', {
            scope: ['profile', 'email'],
            session: false,
            state,
        })(req, res, next);
    },
);

/**
 * GET /v1/auth/google/callback
 * Google redirects here after user consent.
 */
router.get(
    '/google/callback',
    (req: Request, res: Response, next: Function) => {
        const passport = getPassport();
        if (!passport) {
            res.redirect('/login?error=oauth_disabled');
            return;
        }

        // Intercept res.redirect to sanitize / redact code from location headers/Morgan logs
        const originalRedirect = res.redirect.bind(res);
        res.redirect = ((statusOrUrl: number | string, maybeUrl?: string) => {
            const redirectUrl = typeof statusOrUrl === 'string' ? statusOrUrl : maybeUrl;
            const redirectStatus = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
            if (redirectUrl) {
                const sanitized = redirectUrl.replace(/code=[^&]+/, 'code=REDACTED');
                logger.info(`[OAuth Redirect] Sanity Redacted Destination: ${sanitized}`);
            }
            return originalRedirect(redirectStatus, redirectUrl!);
        }) as any;

        passport.authenticate(
            'google',
            { session: false, failureRedirect: '/login?error=oauth_failed' },
            async (err: Error | null, result: any) => {
                res.clearCookie('oauth_nonce');

                if (err || !result) {
                    logger.error('Google OAuth callback error', { error: err?.message });
                    const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';
                    return res.redirect(`${adminUrl}/login?error=oauth_failed`);
                }

                const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';

                // S2-A: Generate short-lived opaque exchange code instead of url hashes
                const code = crypto.randomBytes(32).toString('hex');
                await setOauthCode(`oauth:code:${code}`, JSON.stringify({
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken,
                    intent: result.intent,
                }), 30); // 30-second TTL

                const dest = result.intent === 'register'
                  ? `${adminUrl}/register/restaurant-setup?code=${code}`
                  : `${adminUrl}/login?code=${code}`;

                return res.redirect(dest);
            },
        )(req, res, next);
    },
);

/**
 * POST /v1/auth/exchange
 * Exchanges an opaque OAuth code for JWT tokens.
 */
router.post(
    '/exchange',
    asyncHandler(async (req: Request, res: Response) => {
        const { code } = req.body;
        if (!code) {
            throw ApiError.badRequest('Missing required body parameter: code');
        }

        const cached = await getOauthCode(`oauth:code:${code}`);
        if (!cached) {
            throw ApiError.badRequest('Invalid or expired exchange code');
        }

        // Delete the code so it is single-use
        await delOauthCode(`oauth:code:${code}`);

        const { accessToken, refreshToken, intent } = JSON.parse(cached);

        // Fetch the user information to return it alongside accessToken
        const decoded = jwt.decode(accessToken) as { id: string } | null;
        let user = null;
        if (decoded?.id) {
            const { prisma } = require('../config/database');
            user = await prisma.user.findUnique({
                where: { id: decoded.id },
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    role: true,
                    restaurantId: true,
                    isActive: true,
                    emailVerified: true,
                },
            });
        }

        res.cookie('refreshToken', refreshToken, getCookieOptions());

        sendSuccess(res, HTTP_STATUS.OK, {
            accessToken,
            user,
            intent,
        });
    }),
);

export default router;

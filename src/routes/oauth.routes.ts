import { Router, Request, Response } from 'express';
import { oauthService } from '../services/oauth.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

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

        // Dynamic require to prevent hard crash on import when deps not installed
        try {
            const passport = require('passport');
            const GoogleStrategy = require('passport-google-oauth20').Strategy;

            passport.use(
                new GoogleStrategy(
                    {
                        clientID: googleClientId,
                        clientSecret: googleClientSecret,
                        callbackURL: callbackUrl,
                    },
                    async (_accessToken: string, _refreshToken: string, profile: any, done: Function) => {
                        try {
                            const result = await oauthService.findOrCreateGoogleUser(profile);
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
 * Initiates Google OAuth flow. Redirects to Google consent screen.
 */
router.get(
    '/google',
    (req: Request, res: Response, next: Function) => {
        const passport = getPassport();
        if (!passport) {
            return res.status(503).json({
                success: false,
                error: {
                    code: 'OAUTH_DISABLED',
                    message: 'Google OAuth is not configured on this server',
                },
            });
        }
        passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
    },
);

/**
 * GET /v1/auth/google/callback
 * Google redirects here after user consent.
 * On success: redirect to admin frontend with tokens in hash fragment.
 * On failure: redirect to admin login page with error.
 */
router.get(
    '/google/callback',
    (req: Request, res: Response, next: Function) => {
        const passport = getPassport();
        if (!passport) return res.redirect('/login?error=oauth_disabled');

        passport.authenticate(
            'google',
            { session: false, failureRedirect: '/login?error=oauth_failed' },
            (err: Error | null, result: any) => {
                if (err || !result) {
                    logger.error('Google OAuth callback error', { error: err?.message });
                    const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';
                    return res.redirect(`${adminUrl}/login?error=oauth_failed`);
                }

                const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';

                // Pass tokens via hash fragment — never in query params (prevents server logging)
                const params = new URLSearchParams({
                    access_token: result.accessToken,
                    refresh_token: result.refreshToken,
                });

                return res.redirect(`${adminUrl}/login#${params.toString()}`);
            },
        )(req, res, next);
    },
);

export default router;
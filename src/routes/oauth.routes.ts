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
                            let opts: { role?: string; intent?: string } = {};
                            try {
                                if (req.query.state) {
                                    opts = JSON.parse(
                                        Buffer.from(req.query.state as string, 'base64url').toString('utf8'),
                                    );
                                }
                            } catch {
                                // Malformed state — proceed with defaults
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
 *
 * Optional query params:
 *   ?role=staff    → staff login; callback redirects to staff dashboard
 *   ?intent=register → new owner registration flow; callback redirects to restaurant-setup
 *
 * Params are threaded through the OAuth `state` value (base64url-encoded JSON)
 * so they survive the Google redirect round-trip without touching the callback URL.
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

        // Encode role/intent into state so we can recover them in the callback
        const statePayload: Record<string, string> = {};
        if (req.query.role)   statePayload.role   = req.query.role as string;
        if (req.query.intent) statePayload.intent = req.query.intent as string;

        const state = Object.keys(statePayload).length > 0
            ? Buffer.from(JSON.stringify(statePayload)).toString('base64url')
            : undefined;

        passport.authenticate('google', {
            scope: ['profile', 'email'],
            session: false,
            ...(state ? { state } : {}),
        })(req, res, next);
    },
);

/**
 * GET /v1/auth/google/callback
 * Google redirects here after user consent.
 *
 * On success:
 *  - role=staff    → redirect to {ADMIN_FRONTEND_URL}/login#access_token=...
 *                    (frontend reads role from JWT and routes to /kitchen)
 *  - intent=register → redirect to {ADMIN_FRONTEND_URL}/register/restaurant-setup#tokens=...
 *  - default       → redirect to {ADMIN_FRONTEND_URL}/login#access_token=...
 *
 * On failure: redirect to admin login page with ?error=oauth_failed
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

                const tokenParams = new URLSearchParams({
                    access_token: result.accessToken,
                    refresh_token: result.refreshToken,
                });

                // Route to the correct frontend destination based on intent/role
                if (result.intent === 'register') {
                    // New owner — no restaurant yet; send to restaurant setup step
                    return res.redirect(
                        `${adminUrl}/register/restaurant-setup#${tokenParams.toString()}`,
                    );
                }

                // Default: admin login or staff login — both land on /login
                // The frontend reads role from the JWT and routes accordingly
                return res.redirect(`${adminUrl}/login#${tokenParams.toString()}`);
            },
        )(req, res, next);
    },
);

export default router;

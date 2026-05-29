/**
 * oauth.service.ts — Google OAuth 2.0 architecture for Steward.
 *
 * Architecture: Authorization Code Flow (server-side)
 *   1. Frontend redirects to /v1/auth/google
 *   2. Google redirects back to /v1/auth/google/callback with `code`
 *   3. We exchange `code` for tokens, fetch profile, upsert User, issue JWT
 *   4. Redirect to admin frontend with accessToken in hash fragment
 *
 * Dependencies: passport, passport-google-oauth20
 * Install: npm i passport passport-google-oauth20
 *          npm i -D @types/passport @types/passport-google-oauth20
 */

import { prisma } from '../config/database';
import { signAccessToken, signRefreshToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { UserRole } from '@prisma/client';
import { logger } from '../utils/logger';
import bcrypt from 'bcryptjs';
import { SALT_ROUNDS } from '../constants';

export interface GoogleProfile {
    id: string;
    emails: Array<{ value: string; verified?: boolean }>;
    displayName: string;
    name?: { givenName?: string; familyName?: string };
    photos?: Array<{ value: string }>;
}

export const oauthService = {
    /**
     * Find or create a user from a Google OAuth profile.
     * Only allows ADMIN-level OAuth login — kitchen staff must use PIN login.
     *
     * Flow:
     *  - If email already exists → link Google account, allow login
     *  - If email is new → create ADMIN account WITHOUT a restaurant
     *    (the user will need to register a restaurant separately)
     */
    async findOrCreateGoogleUser(profile: GoogleProfile) {
        const email = profile.emails?.[0]?.value;
        if (!email) throw ApiError.badRequest('Google account has no email', 'OAUTH_NO_EMAIL');

        const firstName = profile.name?.givenName ?? profile.displayName.split(' ')[0] ?? 'User';
        const lastName = profile.name?.familyName ?? '';

        // Try to find existing user
        let user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            // Create new ADMIN user with a placeholder password hash
            // (they will never use password login — only OAuth)
            const placeholderHash = await bcrypt.hash(
                `oauth_${profile.id}_${Date.now()}`,
                SALT_ROUNDS,
            );

            user = await prisma.user.create({
                data: {
                    email,
                    firstName,
                    lastName,
                    passwordHash: placeholderHash,
                    role: UserRole.ADMIN,
                    isActive: true,
                    restaurantId: null, // No restaurant yet — must register
                },
            });

            logger.info('OAuth: new admin user created', { email, googleId: profile.id });
        } else {
            // Block kitchen staff from using OAuth login
            if (user.role === UserRole.KITCHEN_STAFF || user.role === UserRole.WAITER) {
                throw ApiError.forbidden(
                    'Staff accounts must use PIN login. OAuth is for admin accounts only.',
                    'OAUTH_ROLE_FORBIDDEN',
                );
            }

            // Update name if it changed in Google
            if (user.firstName !== firstName || user.lastName !== lastName) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { firstName, lastName },
                });
            }
        }

        if (!user.isActive) {
            throw ApiError.forbidden('Account is deactivated', 'ACCOUNT_DEACTIVATED');
        }

        // Issue JWT tokens
        const accessToken = signAccessToken({
            id: user.id,
            email: user.email,
            role: user.role,
            restaurantId: user.restaurantId,
        });

        const refreshToken = signRefreshToken(user.id);

        // Persist refresh session
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        await prisma.session.create({
            data: { userId: user.id, refreshToken, expiresAt },
        });

        return {
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                restaurantId: user.restaurantId,
            },
        };
    },
};
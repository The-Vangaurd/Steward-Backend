import { redis } from '../config/redis';
import { env } from '../config/env';
import crypto from 'crypto';
import { logger } from './logger';

const memoryCache = new Map<string, { value: string; expiry: number }>();

export async function setVerificationToken(email: string, token: string): Promise<void> {
  const key = `email-verification:${token}`;
  if (redis) {
    try {
      await redis.set(key, email, 'EX', 24 * 60 * 60); // 24 hours
      return;
    } catch (err) {
      logger.warn('Redis set failed for email verification, using memory fallback');
    }
  }
  memoryCache.set(key, {
    value: email,
    expiry: Date.now() + 24 * 60 * 60 * 1000,
  });
}

export async function getVerificationEmail(token: string): Promise<string | null> {
  const key = `email-verification:${token}`;
  if (redis) {
    try {
      return await redis.get(key);
    } catch (err) {
      logger.warn('Redis get failed for email verification, using memory fallback');
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

export async function deleteVerificationToken(token: string): Promise<void> {
  const key = `email-verification:${token}`;
  if (redis) {
    try {
      await redis.del(key);
      return;
    } catch {
      // fallback
    }
  }
  memoryCache.delete(key);
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';
  const verifyUrl = `${adminUrl}/verify-email?token=${token}`;
  
  if (!env.RESEND_API_KEY) {
    logger.warn(`[EMAIL VERIFICATION] RESEND_API_KEY is not set. Verify link is: ${verifyUrl}`);
    return;
  }

  const fromEmail = env.FROM_EMAIL || 'onboarding@resend.dev';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: email,
        subject: 'Verify your email — SpiceOS',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #4f46e5; margin-bottom: 20px;">Welcome to SpiceOS!</h2>
            <p style="font-size: 16px; line-height: 1.5; color: #1e293b;">Thank you for registering. Please click the button below to verify your email and activate your account:</p>
            <div style="margin: 30px 0; text-align: center;">
              <a href="${verifyUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">Verify Email Address</a>
            </div>
            <p style="font-size: 14px; line-height: 1.5; color: #64748b;">Or copy and paste this link in your browser:</p>
            <p style="font-size: 14px; word-break: break-all; color: #4f46e5;"><a href="${verifyUrl}">${verifyUrl}</a></p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0;" />
            <p style="font-size: 12px; color: #94a3b8; text-align: center;">If you did not register for this account, please ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error('Resend API call failed', { status: response.status, body: errText });
    } else {
      logger.info(`Verification email sent to ${email}`);
    }
  } catch (err) {
    logger.error('Failed to send verification email via Resend', { error: (err as Error).message });
  }
}

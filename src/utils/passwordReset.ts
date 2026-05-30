import { redis } from '../config/redis';
import { env } from '../config/env';
import { logger } from './logger';

const memoryCache = new Map<string, { value: string; expiry: number }>();

export async function setPasswordResetToken(email: string, token: string): Promise<void> {
  const key = `password-reset:${token}`;
  if (redis) {
    try {
      await redis.set(key, email, 'EX', 1 * 60 * 60); // 1 hour
      return;
    } catch (err) {
      logger.warn('Redis set failed for password reset, using memory fallback');
    }
  }
  memoryCache.set(key, {
    value: email,
    expiry: Date.now() + 1 * 60 * 60 * 1000,
  });
}

export async function getPasswordResetEmail(token: string): Promise<string | null> {
  const key = `password-reset:${token}`;
  if (redis) {
    try {
      return await redis.get(key);
    } catch (err) {
      logger.warn('Redis get failed for password reset, using memory fallback');
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

export async function deletePasswordResetToken(token: string): Promise<void> {
  const key = `password-reset:${token}`;
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

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const adminUrl = process.env.ADMIN_FRONTEND_URL ?? 'http://localhost:3000';
  const resetUrl = `${adminUrl}/reset-password?token=${token}`;
  
  if (!env.RESEND_API_KEY) {
    logger.warn(`[PASSWORD RESET] RESEND_API_KEY is not set. Reset link is: ${resetUrl}`);
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
        subject: 'Reset your password — Steward',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #4f46e5; margin-bottom: 20px;">Password Reset Request</h2>
            <p style="font-size: 16px; line-height: 1.5; color: #1e293b;">We received a request to reset your password. Click the button below to choose a new one:</p>
            <div style="margin: 30px 0; text-align: center;">
              <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">Reset Password</a>
            </div>
            <p style="font-size: 14px; line-height: 1.5; color: #64748b;">Or copy and paste this link in your browser:</p>
            <p style="font-size: 14px; word-break: break-all; color: #4f46e5;"><a href="${resetUrl}">${resetUrl}</a></p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0;" />
            <p style="font-size: 12px; color: #94a3b8; text-align: center;">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error('Resend API call failed', { status: response.status, body: errText });
    } else {
      logger.info(`Password reset email sent to ${email}`);
    }
  } catch (err) {
    logger.error('Failed to send password reset email via Resend', { error: (err as Error).message });
  }
}

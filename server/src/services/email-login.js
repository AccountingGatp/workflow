import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { EmailCode, LoginLimit, User } from '../models/index.js';
import { HttpError, JWT_SECRET } from '../middleware/auth.js';

import { companyEmail } from './sign-in-requests.js';

const minute = 60000;
const hash = (value) => createHmac('sha256', JWT_SECRET).update(value).digest('hex');
export const emailLoginConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.LOGIN_EMAIL_FROM);
export const demoLoginEnabled = () => process.env.SEED_DEMO === 'true' && !process.env.VERCEL && process.env.NODE_ENV !== 'production';

export function loginEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  return email;
}

export async function limitEmailLogin(req, action, maximum) {
  const forwarded = process.env.VERCEL ? req.get('x-vercel-forwarded-for')?.split(',')[0].trim() : '';
  const ip = isIP(forwarded || '') ? forwarded : req.ip;
  const window = Math.floor(Date.now() / (10 * minute));
  const key = hash(`email-login:${action}:${ip}:${window}`);
  const record = await LoginLimit.findOneAndUpdate({ _id: key }, {
    $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * 10 * minute) },
  }, { upsert: true, returnDocument: 'after' });
  if (record.count > maximum) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
}

export async function requestEmailCode(email) {
  const challenge = randomBytes(24).toString('hex');
  const user = await User.findOne({ email }).select('active deletedAt').lean();
  if (user ? !user.active || user.deletedAt : !companyEmail(email)) return challenge;
  const now = Date.now();
  const code = String(randomInt(1000000)).padStart(6, '0');
  const digest = hash(`${challenge}:${code}`);
  try {
    await EmailCode.updateOne({ _id: hash(email), sentAt: { $lte: new Date(now - minute) } }, {
      $set: { nonce: challenge, digest, sentAt: new Date(now), expiresAt: new Date(now + 10 * minute), attempts: 0 },
    }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return challenge;
    throw error;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.LOGIN_EMAIL_FROM, to: [email], subject: 'Your Workflow sign-in code',
        text: `Your Workflow sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Sender returned HTTP ${response.status}`);
  } catch {
    // Keep the response identical for registered and unregistered addresses.
    console.error('Workflow sign-in email delivery failed');
    await EmailCode.deleteOne({ _id: hash(email), nonce: challenge });
  }
  return challenge;
}

export async function verifyEmailCode(email, challenge, code) {
  if (typeof challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge) ||
      typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const scope = { _id: hash(email), nonce: challenge, expiresAt: { $gt: new Date() } };
  const record = await EmailCode.findOneAndUpdate({ ...scope, attempts: { $lt: 5 } },
    { $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
  if (!record || record.digest !== hash(`${challenge}:${code}`)) return null;
  const consumed = await EmailCode.deleteOne(scope);
  return Boolean(consumed.deletedCount);
}

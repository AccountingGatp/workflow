import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
import { requireAuth, ah, JWT_SECRET, startSession, endSession } from '../middleware/auth.js';
import { audit, userTeamIds } from '../services/access.js';
import { demoLoginEnabled, emailLoginConfigured, limitEmailLogin, loginEmail, requestEmailCode, verifyEmailCode } from '../services/email-login.js';

const r = Router();
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const google = new OAuth2Client();
const nonceCookie = 'workflow_google_nonce';
const nonceOptions = { httpOnly: true, sameSite: 'strict', secure: !!process.env.VERCEL, path: '/api/auth/google' };

async function signIn(user, res) {
  await startSession(res, user);
  audit(user, 'auth.login', { entity: 'User', entityId: user._id, summary: `${user.name} signed in` });
  const { passwordHash, googleSubject, ...safe } = user.toObject();
  res.json({ user: safe });
}

r.get('/google/nonce', (_req, res) => {
  if (!process.env.GOOGLE_SIGN_IN_CLIENT_ID) return res.status(404).json({ error: 'Google sign-in is unavailable' });
  const nonce = randomBytes(32).toString('hex');
  const cookie = jwt.sign({ nonce, purpose: nonceCookie }, JWT_SECRET, { expiresIn: '10m' });
  res.set('Cache-Control', 'no-store').cookie(nonceCookie, cookie, { ...nonceOptions, maxAge: 600000 }).json({ nonce });
});

r.post('/google', ah(async (req, res) => {
  const audience = process.env.GOOGLE_SIGN_IN_CLIENT_ID;
  if (!audience) return res.status(404).json({ error: 'Google sign-in is unavailable' });
  let payload;
  try {
    const cookie = req.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(nonceCookie + '='));
    const nonce = jwt.verify(cookie?.slice(nonceCookie.length + 1), JWT_SECRET);
    const ticket = await google.verifyIdToken({ idToken: req.body?.credential, audience });
    payload = ticket.getPayload();
    if (nonce.purpose !== nonceCookie || nonce.nonce !== payload?.nonce || !payload.email_verified) throw new Error('Invalid Google session');
  } catch {
    return res.status(401).json({ error: 'Google sign-in expired or could not be verified. Reload and try again.' });
  }
  const email = payload.email?.toLowerCase();
  const linked = await User.findOne({ googleSubject: payload.sub, active: true }).select('+googleSubject');
  let user = linked?.email === email ? linked : null;
  if (!linked && email && (email.endsWith('@gmail.com') || payload.hd)) {
    user = await User.findOneAndUpdate({ email, active: true, googleSubject: { $exists: false } },
      { $set: { googleSubject: payload.sub } }, { returnDocument: 'after' });
  }
  if (!user) return res.status(401).json({ error: 'Use the Google Workspace or Gmail address on your active Workflow account' });
  res.clearCookie(nonceCookie, nonceOptions);
  await signIn(user, res);
}));

r.post('/email/request', ah(async (req, res) => {
  if (!emailLoginConfigured()) return res.status(503).json({ error: 'Email sign-in is not configured. Contact your Workflow administrator.' });
  const email = loginEmail(req.body?.email);
  await limitEmailLogin(req, 'send', 30);
  res.json({ challenge: await requestEmailCode(email) });
}));

r.post('/email/verify', ah(async (req, res) => {
  const email = loginEmail(req.body?.email);
  await limitEmailLogin(req, 'verify', 100);
  const user = await verifyEmailCode(email, req.body?.challenge, req.body?.code);
  if (!user) return res.status(401).json({ error: 'That code is invalid or expired. Check it or request a new code.' });
  await signIn(user, res);
}));

r.post('/demo', ah(async (req, res) => {
  if (!demoLoginEnabled()) return res.status(404).json({ error: 'Demo sign-in is unavailable' });
  const email = loginEmail(req.body?.email);
  if (!email.endsWith('@demo.test')) return res.status(404).json({ error: 'Demo account not found' });
  const user = await User.findOne({ email, active: true, deletedAt: null });
  if (!user) return res.status(404).json({ error: 'Demo account not found' });
  await signIn(user, res);
}));

r.post('/logout', ah(async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
}));

r.get('/me', requireAuth, ah(async (req, res) => {
  res.json({ user: req.user, teamIds: await userTeamIds(req.user._id) });
}));

export default r;

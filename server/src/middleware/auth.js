import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { AuthSession, User } from '../models/index.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

const secureCookies = !!process.env.VERCEL || process.env.NODE_ENV === 'production';
const cookieName = secureCookies ? '__Host-workflow_session' : 'workflow_session';
const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' };
const day = 86400000;
const sessionLifetime = 365 * day;
const sessionId = (token) => createHash('sha256').update(token).digest('hex');

function sessionToken(req) {
  const cookie = req.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(cookieName + '='));
  const token = cookie?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}

export async function startSession(res, user) {
  const token = randomBytes(32).toString('hex');
  await AuthSession.create({ _id: sessionId(token), user: user._id, email: user.email, expiresAt: new Date(Date.now() + sessionLifetime) });
  res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
}

export async function endSession(req, res) {
  const token = sessionToken(req);
  if (token) await AuthSession.deleteOne({ _id: sessionId(token) });
  res.clearCookie(cookieName, cookieOptions);
}

export async function requireAuth(req, res, next) {
  try {
    const token = sessionToken(req);
    let user;
    if (token) {
      const now = Date.now();
      const session = await AuthSession.findOne({ _id: sessionId(token), expiresAt: { $gt: new Date(now) } }).lean();
      if (session) {
        user = await User.findOne({ _id: session.user, active: true, deletedAt: null, email: session.email });
        if (user && +session.expiresAt <= now + sessionLifetime - day) {
          const result = await AuthSession.updateOne({ _id: session._id, expiresAt: session.expiresAt },
            { $set: { expiresAt: new Date(now + sessionLifetime) } });
          if (result.modifiedCount) res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
        }
      }
    } else {
      const header = req.headers.authorization || '';
      if (header.startsWith('Bearer ')) {
        let claims;
        try { claims = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] }); } catch { /* Expired legacy login. */ }
        if (claims?.sub && !claims.purpose && (!secureCookies || (claims.exp && claims.iat && claims.exp - claims.iat <= 43200))) {
          user = await User.findOne({ _id: claims.sub, active: true, deletedAt: null });
        }
      }
    }
    if (!user) return res.status(401).json({ error: 'Sign in to continue' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function enforceWorkReadOnly(req, res, next) {
  if (req.user.role === 'hr' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'HR has read-only Workflow access' });
  }
  next();
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission for this' });

/** Wrap async handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

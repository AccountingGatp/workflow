import crypto from 'node:crypto';
import { Client } from '../models/index.js';
import { MailAccount, MailMessage, MailThread } from '../models/mail.js';

/*
 * Talks to Gmail over its REST API. Scopes are the minimum we need: read and send.
 * GOOGLE_AUTH_BASE / GOOGLE_TOKEN_URL / GMAIL_API_BASE exist so scripts/fake-gmail.js
 * can stand in for Google during local testing.
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const env = () => ({
  id: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 4000}/api/mail/oauth/callback`,
  authBase: process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  api: process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1',
});

export const gmailConfigured = () => !!(env().id && env().secret && process.env.MAIL_TOKEN_KEY);

/* ---------- Token encryption ---------- */

const key = () => crypto.createHash('sha256').update(String(process.env.MAIL_TOKEN_KEY)).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ---------- OAuth ---------- */

export function authUrl(state) {
  const e = env();
  const q = new URLSearchParams({
    client_id: e.id, redirect_uri: e.redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state,
  });
  return `${e.authBase}?${q}`;
}

async function tokenRequest(params) {
  const e = env();
  const res = await fetch(e.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.id, client_secret: e.secret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || 'Google sign-in failed'), { code: data.error });
  return data;
}

export const exchangeCode = (code) => tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: env().redirect });

async function accessToken(account) {
  const withToken = await MailAccount.findById(account._id).select('+refreshToken');
  const { access_token: token } = await tokenRequest({ refresh_token: decrypt(withToken.refreshToken), grant_type: 'refresh_token' });
  return token;
}

async function gmail(token, path, options = {}) {
  const res = await fetch(`${env().api}/users/me${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || `Gmail error ${res.status}`), { status: res.status });
  return data;
}

export const getProfile = (token) => gmail(token, '/profile');

/* ---------- Parsing ---------- */

const decode64 = (s = '') => Buffer.from(s, 'base64url').toString('utf8');
export const addressOf = (v = '') => (v.match(/<([^>]+)>/)?.[1] || v).trim().toLowerCase();
const allAddresses = (v = '') => (v.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || []).map((a) => a.toLowerCase());

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMessage(m) {
  const headers = Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  let plain = ''; let html = ''; const attachments = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename) attachments.push({ filename: p.filename, size: p.body?.size || 0 });
    else if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode64(p.body.data);
    (p.parts || []).forEach(walk);
  }(m.payload));
  const date = Number(m.internalDate) ? new Date(Number(m.internalDate)) : new Date(headers.date || Date.now());
  return {
    gmailMessageId: m.id, gmailThreadId: m.threadId, labelIds: m.labelIds || [], snippet: m.snippet || '',
    rfcMessageId: headers['message-id'], references: headers.references,
    from: headers.from || '', replyTo: headers['reply-to'], to: headers.to || '', cc: headers.cc,
    subject: headers.subject || '(no subject)', date,
    text: (plain || htmlToText(html)).slice(0, 200000), attachments,
  };
}

/* ---------- Automatic client tagging ---------- */

/** Finds the one client whose email rules match; anything ambiguous stays untagged for a person. */
export function matchClient(addresses, clients) {
  const hits = new Set();
  for (const a of addresses) {
    const domain = a.split('@')[1];
    for (const c of clients) {
      if ((c.emailMatches || []).some((m) => m === a || m === domain)) hits.add(String(c._id));
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

const loadRules = () => Client.find({ emailMatches: { $exists: true, $ne: [] } }).select('emailMatches').lean();

/** Re-check untagged conversations, e.g. after someone adds email addresses to a client. */
export async function retagUntagged() {
  const clients = await loadRules();
  const threads = await MailThread.find({ client: null }).populate('account', 'email');
  for (const t of threads) {
    const others = t.participants.filter((p) => p !== t.account?.email);
    const client = matchClient(others, clients);
    if (client) { t.client = client; t.tagSource = 'auto'; await t.save(); }
  }
}

/* ---------- Sync ---------- */

async function storeMessage(account, raw, clients) {
  const m = parseMessage(raw);
  if (m.labelIds.some((l) => ['SPAM', 'TRASH', 'DRAFT'].includes(l))) return;
  const outbound = addressOf(m.from) === account.email;
  const addresses = [...allAddresses(m.from), ...allAddresses(m.to), ...allAddresses(m.cc)];

  let thread = await MailThread.findOne({ account: account._id, gmailThreadId: m.gmailThreadId });
  if (!thread) thread = new MailThread({ account: account._id, gmailThreadId: m.gmailThreadId, subject: m.subject });
  if (await MailMessage.exists({ account: account._id, gmailMessageId: m.gmailMessageId })) return;

  thread.participants = [...new Set([...thread.participants, ...addresses])];
  if (!thread.lastMessageAt || m.date >= thread.lastMessageAt) { thread.lastMessageAt = m.date; thread.snippet = m.snippet; }
  thread.messageCount += 1;
  if (!thread.client) {
    const client = matchClient(thread.participants.filter((p) => p !== account.email), clients);
    if (client) { thread.client = client; thread.tagSource = 'auto'; }
  }
  if (!outbound && thread.status === 'done') thread.status = 'open'; // a new client email reopens it
  await thread.save();

  const { gmailThreadId, labelIds, snippet, ...fields } = m;
  await MailMessage.updateOne(
    { account: account._id, gmailMessageId: m.gmailMessageId },
    { $setOnInsert: { ...fields, thread: thread._id, account: account._id, direction: outbound ? 'out' : 'in' } },
    { upsert: true },
  );
}

async function initialIds(token) {
  const list = await gmail(token, `/messages?maxResults=${process.env.MAIL_INITIAL_MESSAGES || 200}&q=${encodeURIComponent('newer_than:30d')}`);
  return (list.messages || []).map((x) => x.id).reverse();
}

const syncing = new Set();

export async function syncAccount(accountId) {
  const id = String(accountId);
  if (syncing.has(id)) return { skipped: true };
  syncing.add(id);
  const account = await MailAccount.findById(accountId);
  try {
    const token = await accessToken(account);
    const profile = await getProfile(token);
    let ids;
    if (account.historyId) {
      try {
        ids = []; let pageToken;
        do {
          const h = await gmail(token, `/history?startHistoryId=${account.historyId}&historyTypes=messageAdded${pageToken ? `&pageToken=${pageToken}` : ''}`);
          for (const row of h.history || []) for (const a of row.messagesAdded || []) ids.push(a.message.id);
          pageToken = h.nextPageToken;
        } while (pageToken);
      } catch (e) {
        if (e.status !== 404) throw e; // Google forgot this position: read recent mail again
        ids = await initialIds(token);
      }
    } else ids = await initialIds(token);

    const clients = await loadRules();
    let imported = 0;
    for (const mid of [...new Set(ids)]) {
      try {
        await storeMessage(account, await gmail(token, `/messages/${mid}?format=full`), clients);
        imported += 1;
      } catch (e) { if (e.status !== 404) throw e; } // deleted before we read it
    }
    account.historyId = profile.historyId;
    account.status = 'active'; account.lastError = undefined; account.lastSyncAt = new Date();
    await account.save();
    return { imported };
  } catch (e) {
    account.status = 'error';
    account.lastError = e.code === 'invalid_grant' ? 'Google access was removed. Connect this inbox again.' : e.message;
    await account.save();
    throw e;
  } finally { syncing.delete(id); }
}

export function startMailSync() {
  if (!gmailConfigured()) return;
  const run = async () => {
    for (const a of await MailAccount.find({ status: { $ne: 'disconnected' } }).select('_id')) {
      await syncAccount(a._id).catch((e) => console.error('Mail sync failed:', e.message));
    }
  };
  run().catch(console.error);
  setInterval(() => run().catch(console.error), Number(process.env.MAIL_SYNC_SECONDS || 120) * 1000);
}

/* ---------- Sending ---------- */

const clean = (s = '') => String(s).replace(/[\r\n]+/g, ' ').trim(); // blocks header injection
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

export function buildRaw({ from, to, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${clean(from)}`, `To: ${clean(to)}`, `Subject: ${encodeHeader(clean(subject))}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${clean(inReplyTo)}`);
  if (inReplyTo) lines.push(`References: ${clean(`${references || ''} ${inReplyTo}`)}`);
  const b64 = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${b64}`).toString('base64url');
}

/** Sends a reply in the thread and records it straight away (the next sync skips the duplicate). */
export async function sendReply(thread, to, body) {
  const account = await MailAccount.findById(thread.account);
  const last = await MailMessage.findOne({ thread: thread._id }).sort({ date: -1 });
  const subject = /^re:/i.test(thread.subject || '') ? thread.subject : `Re: ${thread.subject || ''}`;
  const token = await accessToken(account);
  const raw = buildRaw({ from: account.email, to, subject, body, inReplyTo: last?.rfcMessageId, references: last?.references });
  const sent = await gmail(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw, threadId: thread.gmailThreadId }) });
  const date = new Date();
  await MailMessage.updateOne(
    { account: account._id, gmailMessageId: sent.id },
    { $setOnInsert: { thread: thread._id, account: account._id, from: account.email, to, subject, date, text: body, direction: 'out' } },
    { upsert: true },
  );
  thread.lastMessageAt = date; thread.snippet = body.slice(0, 140); thread.messageCount += 1;
  await thread.save();
  return sent.id;
}

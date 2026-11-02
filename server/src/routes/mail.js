import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Client, ClientAssignment, Task, User } from '../models/index.js';
import { MailAccount, MailMessage, MailReply, MailThread } from '../models/mail.js';
import { ah, HttpError, JWT_SECRET, requireAuth, requireRole } from '../middleware/auth.js';
import {
  audit, canManageClient, canSeeClient, isSuper, ledTeamIds, managedClientIds, visibleClientIds,
} from '../services/access.js';
import {
  addressOf, authUrl, encrypt, exchangeCode, getProfile, gmailConfigured, sendReply, syncAccount,
} from '../services/gmail.js';

const r = Router();
const clientUrl = () => process.env.CLIENT_URL || 'http://localhost:5173';

/* ---------- Access rules for mail ---------- */

/** Tagged mail follows client access. Untagged mail: only the Owner and the inbox team's TL. */
async function threadScope(user) {
  if (isSuper(user)) return {};
  const visible = await visibleClientIds(user);
  const led = await ledTeamIds(user);
  const accounts = led.length ? (await MailAccount.find({ team: { $in: led } }).select('_id')).map((a) => a._id) : [];
  return { $or: [{ client: { $in: visible } }, { client: null, account: { $in: accounts } }] };
}

async function loadThread(user, id) {
  const thread = await MailThread.findOne({ $and: [{ _id: id }, await threadScope(user)] });
  if (!thread) throw new HttpError(404, 'Conversation not found');
  return thread;
}

/* ---------- Connecting inboxes ---------- */

// Google redirects the browser here, so it has no login header: the signed state proves who started it.
export const mailPublic = Router();
mailPublic.get('/mail/oauth/callback', ah(async (req, res) => {
  const back = (q) => res.redirect(`${clientUrl()}/mail/inboxes?${new URLSearchParams(q)}`);
  try {
    if (req.query.error) return back({ error: 'Google connection was cancelled.' });
    const state = jwt.verify(String(req.query.state), JWT_SECRET);
    if (state.purpose !== 'mail-connect') throw new Error('Bad state');
    const actor = await User.findById(state.sub);
    if (!actor || !actor.active || !isSuper(actor)) throw new Error('Not allowed');
    const tokens = await exchangeCode(String(req.query.code));
    if (!tokens.refresh_token) return back({ error: 'Google did not allow offline access. Try connecting again.' });
    const { emailAddress } = await getProfile(tokens.access_token);
    const account = await MailAccount.findOneAndUpdate(
      { email: emailAddress.toLowerCase() },
      {
        refreshToken: encrypt(tokens.refresh_token), status: 'active', lastError: null, connectedBy: actor._id,
        ...(state.team ? { team: state.team } : {}),
      },
      { upsert: true, new: true },
    );
    audit(actor, 'mail.connect', { entity: 'MailAccount', entityId: account._id, summary: `Connected inbox ${account.email}` });
    syncAccount(account._id).catch((e) => console.error('First mail sync failed:', e.message));
    back({ connected: account.email });
  } catch (e) {
    console.error('Mail connect failed:', e.message);
    back({ error: 'Could not connect that inbox. Please try again.' });
  }
}));

r.use(requireAuth);

r.get('/mail/accounts', requireRole('super_admin', 'admin'), ah(async (req, res) => {
  const led = await ledTeamIds(req.user);
  const filter = led === null ? {} : { team: { $in: led } };
  const accounts = await MailAccount.find(filter).sort({ email: 1 }).populate('team', 'name color').lean();
  res.json({ configured: gmailConfigured(), accounts });
}));

r.post('/mail/accounts/connect', requireRole('super_admin'), ah(async (req, res) => {
  if (!gmailConfigured()) throw new HttpError(400, 'Google is not set up yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MAIL_TOKEN_KEY to server/.env.');
  const state = jwt.sign({ sub: String(req.user._id), purpose: 'mail-connect', team: req.body?.team || undefined }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ url: authUrl(state) });
}));

r.patch('/mail/accounts/:id', requireRole('super_admin'), ah(async (req, res) => {
  const account = await MailAccount.findByIdAndUpdate(req.params.id, { team: req.body?.team || null }, { new: true });
  if (!account) throw new HttpError(404, 'Inbox not found');
  res.json(account);
}));

r.post('/mail/accounts/:id/sync', requireRole('super_admin'), ah(async (req, res) => {
  if (!(await MailAccount.exists({ _id: req.params.id }))) throw new HttpError(404, 'Inbox not found');
  try { res.json(await syncAccount(req.params.id)); } catch (e) { throw new HttpError(502, `Sync failed: ${e.message}`); }
}));

/** Stops syncing and forgets the Google token. Stored mail and its history stay. */
r.delete('/mail/accounts/:id', requireRole('super_admin'), ah(async (req, res) => {
  const account = await MailAccount.findByIdAndUpdate(req.params.id, { status: 'disconnected', $unset: { refreshToken: 1, historyId: 1 } }, { new: true });
  if (!account) throw new HttpError(404, 'Inbox not found');
  audit(req.user, 'mail.disconnect', { entity: 'MailAccount', entityId: account._id, summary: `Disconnected inbox ${account.email}` });
  res.json({ ok: true });
}));

/* ---------- Conversations ---------- */

r.get('/mail/threads', ah(async (req, res) => {
  const { view = 'open', client, q } = req.query;
  const and = [await threadScope(req.user)];
  if (view === 'open') and.push({ status: 'open' });
  if (view === 'done') and.push({ status: 'done' });
  if (view === 'untagged') and.push({ client: null, status: 'open' });
  if (view === 'mine') and.push({ assignee: req.user._id, status: 'open' });
  if (client) and.push({ client });
  if (q) {
    const safe = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ subject: safe }, { snippet: safe }, { participants: safe }] });
  }
  const threads = await MailThread.find({ $and: and }).sort({ lastMessageAt: -1 }).limit(200)
    .select('-comments').populate('client', 'name').populate('assignee', 'name').populate('account', 'email').lean();
  const pending = await MailReply.aggregate([
    { $match: { thread: { $in: threads.map((t) => t._id) }, status: 'pending' } },
    { $group: { _id: '$thread', n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(pending.map((p) => [String(p._id), p.n]));
  res.json(threads.map((t) => ({ ...t, pendingReplies: counts[t._id] || 0 })));
}));

r.get('/mail/threads/:id', ah(async (req, res) => {
  const base = await loadThread(req.user, req.params.id);
  const thread = await MailThread.findById(base._id)
    .populate('client', 'name').populate('assignee', 'name').populate('account', 'email').populate('comments.author', 'name').lean();
  const [messages, replies, tasks] = await Promise.all([
    MailMessage.find({ thread: base._id }).sort({ date: 1 }).lean(),
    MailReply.find({ thread: base._id, status: { $ne: 'sent' } }).sort({ createdAt: 1 })
      .populate('author', 'name').populate('reviewedBy', 'name').lean(),
    Task.find({ mailThread: base._id }).select('title status dueDate').lean(),
  ]);
  const canReview = base.client ? await canManageClient(req.user, base.client) : false;
  res.json({
    ...thread, messages, replies, tasks, canReview,
    replyTo: replyTarget(messages, thread.account?.email),
  });
}));

/** Who a reply goes to: always worked out here from the last email received. */
function replyTarget(messages, ownEmail) {
  const lastIn = [...messages].reverse().find((m) => addressOf(m.from) !== ownEmail);
  if (lastIn) return lastIn.replyTo || lastIn.from;
  return [...messages].reverse()[0]?.to || null;
}

r.patch('/mail/threads/:id', ah(async (req, res) => {
  const thread = await loadThread(req.user, req.params.id);
  const { client, assignee, status } = req.body || {};
  const notes = [];
  if (client !== undefined) {
    if (!client) throw new HttpError(400, 'Choose a client');
    if (!(await canSeeClient(req.user, client))) throw new HttpError(403, 'You do not have access to that client');
    const c = await Client.findById(client).select('name');
    if (!c) throw new HttpError(404, 'Client not found');
    thread.client = client; thread.tagSource = 'manual'; notes.push(`tagged ${c.name}`);
    if (thread.assignee && !(await canSeeClient(await User.findById(thread.assignee), client))) thread.assignee = undefined;
  }
  if (assignee !== undefined) {
    if (assignee) {
      const u = await User.findOne({ _id: assignee, active: true, deletedAt: null });
      if (!u) throw new HttpError(400, 'Unknown person');
      if (!thread.client) throw new HttpError(400, 'Tag a client first');
      if (!(await canSeeClient(u, thread.client))) throw new HttpError(400, `${u.name} has no access to this client`);
      thread.assignee = u._id; notes.push(`assigned to ${u.name}`);
    } else { thread.assignee = undefined; notes.push('unassigned'); }
  }
  if (status) {
    if (!['open', 'done'].includes(status)) throw new HttpError(400, 'Unknown status');
    thread.status = status; notes.push(`marked ${status}`);
  }
  await thread.save();
  if (notes.length) audit(req.user, 'mail.update', { entity: 'MailThread', entityId: thread._id, client: thread.client, summary: `“${thread.subject}”: ${notes.join(', ')}` });
  res.json(thread);
}));

r.post('/mail/threads/:id/comments', ah(async (req, res) => {
  const thread = await loadThread(req.user, req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) throw new HttpError(400, 'Write a comment first');
  thread.comments.push({ author: req.user._id, text });
  await thread.save();
  res.status(201).json({ ok: true });
}));

/** Anyone handling the client can turn an email into a task for themselves. */
r.post('/mail/threads/:id/task', ah(async (req, res) => {
  const thread = await loadThread(req.user, req.params.id);
  if (!thread.client) throw new HttpError(400, 'Tag a client first');
  const assignment = await ClientAssignment.findOne({ client: thread.client, team: { $ne: null }, endedAt: null });
  const due = new Date(); due.setDate(due.getDate() + 1); due.setHours(17, 0, 0, 0);
  const task = await Task.create({
    title: req.body?.title || thread.subject || 'Email follow-up', client: thread.client, team: assignment?.team,
    assignees: [req.user._id], owner: req.user._id, dueDate: req.body?.dueDate || due, createdBy: req.user._id,
    mailThread: thread._id, sop: thread.snippet ? `From email: ${thread.snippet}` : undefined,
  });
  audit(req.user, 'task.create', { entity: 'Task', entityId: task._id, client: thread.client, summary: `Created “${task.title}” from an email` });
  res.status(201).json(task);
}));

/* ---------- Replies and review ---------- */

async function deliver(reply, thread, actor) {
  const claimed = await MailReply.findOneAndUpdate(
    { _id: reply._id, status: { $in: ['pending', 'failed'] } }, // only one click can ever send it
    { status: 'sending', error: null }, { new: true },
  );
  if (!claimed) throw new HttpError(409, 'This reply was already handled');
  try {
    const id = await sendReply(thread, claimed.to, claimed.body);
    claimed.status = 'sent'; claimed.sentAt = new Date(); claimed.gmailMessageId = id;
    await claimed.save();
    audit(actor, 'mail.send', { entity: 'MailReply', entityId: claimed._id, client: claimed.client, summary: `Sent a reply on “${thread.subject}”` });
    return claimed;
  } catch (e) {
    claimed.status = 'failed'; claimed.error = e.message;
    await claimed.save();
    throw new HttpError(502, `Gmail could not send this: ${e.message}`);
  }
}

r.post('/mail/threads/:id/replies', ah(async (req, res) => {
  const thread = await loadThread(req.user, req.params.id);
  if (!thread.client) throw new HttpError(400, 'Tag a client before replying');
  const body = String(req.body?.body || '').trim();
  if (!body) throw new HttpError(400, 'Write your reply first');
  const account = await MailAccount.findById(thread.account);
  if (account.status === 'disconnected') throw new HttpError(400, 'This inbox is disconnected');
  const messages = await MailMessage.find({ thread: thread._id }).sort({ date: 1 }).lean();
  const to = replyTarget(messages, account.email);
  if (!to) throw new HttpError(400, 'Could not work out who to reply to');
  const reply = await MailReply.create({ thread: thread._id, client: thread.client, author: req.user._id, body, to });
  // The client's TL and the Owner send directly; everyone else needs review
  if (await canManageClient(req.user, thread.client)) {
    const sent = await deliver(reply, thread, req.user);
    return res.status(201).json({ status: sent.status });
  }
  audit(req.user, 'mail.review_request', { entity: 'MailReply', entityId: reply._id, client: thread.client, summary: `Sent a reply on “${thread.subject}” for review` });
  res.status(201).json({ status: 'pending' });
}));

r.get('/mail/reviews', ah(async (req, res) => {
  const managed = await managedClientIds(req.user);
  const filter = { status: { $in: ['pending', 'failed'] }, ...(managed === null ? {} : { client: { $in: managed } }) };
  res.json(await MailReply.find(filter).sort({ createdAt: 1 })
    .populate('author', 'name').populate('client', 'name').populate('thread', 'subject').lean());
}));

async function loadForReview(user, id) {
  const reply = await MailReply.findById(id);
  if (!reply) throw new HttpError(404, 'Reply not found');
  if (!(await canManageClient(user, reply.client))) throw new HttpError(403, 'Only this client’s TL or the Owner can review replies');
  return reply;
}

r.post('/mail/replies/:id/approve', ah(async (req, res) => {
  const reply = await loadForReview(req.user, req.params.id);
  if (!['pending', 'failed'].includes(reply.status)) throw new HttpError(409, 'This reply was already handled');
  const body = String(req.body?.body ?? reply.body).trim();
  if (!body) throw new HttpError(400, 'The reply is empty');
  if (body !== reply.body) { reply.body = body; reply.editedByReviewer = true; }
  reply.reviewedBy = req.user._id; reply.reviewedAt = new Date();
  await reply.save();
  const thread = await MailThread.findById(reply.thread);
  const sent = await deliver(reply, thread, req.user);
  res.json({ status: sent.status });
}));

r.post('/mail/replies/:id/send-back', ah(async (req, res) => {
  const reply = await loadForReview(req.user, req.params.id);
  const note = String(req.body?.note || '').trim();
  if (!note) throw new HttpError(400, 'Tell them what to change');
  const updated = await MailReply.findOneAndUpdate(
    { _id: reply._id, status: 'pending' },
    { status: 'sent_back', reviewNote: note, reviewedBy: req.user._id, reviewedAt: new Date() }, { new: true },
  );
  if (!updated) throw new HttpError(409, 'This reply was already handled');
  audit(req.user, 'mail.send_back', { entity: 'MailReply', entityId: reply._id, client: reply.client, summary: 'Sent a reply back for changes' });
  res.json({ status: 'sent_back' });
}));

/** The author edits a sent-back reply and submits it for review again. */
r.patch('/mail/replies/:id', ah(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) throw new HttpError(400, 'Write your reply first');
  const updated = await MailReply.findOneAndUpdate(
    { _id: req.params.id, author: req.user._id, status: 'sent_back' },
    { body, status: 'pending', $unset: { reviewNote: 1, reviewedBy: 1, reviewedAt: 1 } }, { new: true },
  );
  if (!updated) throw new HttpError(404, 'Reply not found or not waiting for your changes');
  res.json({ status: 'pending' });
}));

export default r;

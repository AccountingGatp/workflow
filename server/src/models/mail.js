import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;
const ref = (name) => ({ type: Types.ObjectId, ref: name });
const opts = { timestamps: true };

/** A connected Gmail mailbox. The refresh token is encrypted and never returned by default. */
export const MailAccount = model('MailAccount', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  team: ref('Team'), // whose TL sees this inbox's untagged mail
  refreshToken: { type: String, select: false },
  historyId: String,
  status: { type: String, enum: ['active', 'error', 'disconnected'], default: 'active' },
  lastError: String,
  lastSyncAt: Date,
  connectedBy: ref('User'),
}, opts), 'mail_accounts');

const commentSchema = new Schema({
  author: ref('User'),
  text: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

/** One conversation. `client: null` means it is not tagged yet. */
const threadSchema = new Schema({
  account: { ...ref('MailAccount'), required: true },
  gmailThreadId: { type: String, required: true },
  subject: String,
  snippet: String,
  participants: [String],
  client: { ...ref('Client'), default: null },
  tagSource: { type: String, enum: ['auto', 'manual'] },
  assignee: ref('User'),
  status: { type: String, enum: ['open', 'done'], default: 'open' },
  lastMessageAt: Date,
  messageCount: { type: Number, default: 0 },
  comments: [commentSchema],
}, opts);
threadSchema.index({ account: 1, gmailThreadId: 1 }, { unique: true });
threadSchema.index({ client: 1, lastMessageAt: -1 });
export const MailThread = model('MailThread', threadSchema, 'mail_threads');

const messageSchema = new Schema({
  thread: { ...ref('MailThread'), required: true },
  account: { ...ref('MailAccount'), required: true },
  gmailMessageId: { type: String, required: true },
  rfcMessageId: String,
  references: String,
  from: String,
  replyTo: String,
  to: String,
  cc: String,
  subject: String,
  date: Date,
  text: String, // plain text only, so email content can never run as code in the app
  attachments: [{ filename: String, size: Number, _id: false }],
  direction: { type: String, enum: ['in', 'out'], default: 'in' },
}, opts);
messageSchema.index({ account: 1, gmailMessageId: 1 }, { unique: true });
messageSchema.index({ thread: 1, date: 1 });
export const MailMessage = model('MailMessage', messageSchema, 'mail_messages');

/** A reply on its way out. Staff replies wait for review; every step is recorded. */
export const MailReply = model('MailReply', new Schema({
  thread: { ...ref('MailThread'), required: true },
  client: { ...ref('Client'), required: true },
  author: { ...ref('User'), required: true },
  body: { type: String, required: true },
  to: String,
  status: { type: String, enum: ['pending', 'sent_back', 'sending', 'sent', 'failed'], default: 'pending' },
  reviewedBy: ref('User'),
  reviewNote: String,
  reviewedAt: Date,
  editedByReviewer: { type: Boolean, default: false },
  sentAt: Date,
  gmailMessageId: String,
  error: String,
}, opts), 'mail_replies');

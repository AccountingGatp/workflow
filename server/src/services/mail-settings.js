import { model, Schema } from 'mongoose';
import { ah, HttpError } from '../middleware/auth.js';

const MailSettings = model('MailSettings', new Schema({
  _id: String,
  enabled: { type: Boolean, required: true },
}), 'workflow_settings');

export async function mailEnabled() {
  const settings = await MailSettings.findById('mail').lean();
  return settings?.enabled !== false;
}

export async function setMailEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'Choose whether to enable Mail');
  await MailSettings.updateOne({ _id: 'mail' }, { $set: { enabled } }, { upsert: true });
  return enabled;
}

export const requireMailEnabled = ah(async (_req, _res, next) => {
  if (!await mailEnabled()) throw new HttpError(403, 'Mail is turned off for this workspace');
  next();
});

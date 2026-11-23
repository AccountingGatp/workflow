import { model, Schema } from 'mongoose';
import { HttpError } from '../middleware/auth.js';

const ProjectAccessSettings = model('ProjectAccessSettings', new Schema({
  _id: String,
  enabled: { type: Boolean, required: true },
}), 'workflow_settings');

const settingId = 'all-project-access';

export async function allProjectsEnabled(user) {
  if (user && (user.active === false || user.deletedAt || user.role === 'super_admin')) return false;
  return (await ProjectAccessSettings.findById(settingId).lean())?.enabled === true;
}

export async function setAllProjectsEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'Choose whether to enable access to all projects');
  await ProjectAccessSettings.findOneAndUpdate({ _id: settingId }, { $set: { enabled } }, { upsert: true });
  return enabled;
}

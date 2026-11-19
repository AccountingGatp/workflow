import { HttpError } from '../middleware/auth.js';

export const validTime = (time) => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

export const defaultStatusReminder = {
  _id: 'status-reminder',
  name: 'Task status reminder',
  time: '18:35',
  enabled: true,
  notifyChannel: true,
  message: 'Team, please update the work status of your tasks on Workflow.',
};

export function parseStatusReminder(value) {
  const { enabled, notifyChannel, time } = value;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (!name || name.length > 80) throw new HttpError(400, 'Enter a reminder name of up to 80 characters');
  if (!validTime(time)) throw new HttpError(400, 'Enter a valid reminder time');
  if (!message || message.length > 1000) throw new HttpError(400, 'Enter a Slack message of up to 1,000 characters');
  if (typeof enabled !== 'boolean' || typeof notifyChannel !== 'boolean') {
    throw new HttpError(400, 'Choose whether to enable the reminder and notify the channel');
  }
  return { name, time, enabled, notifyChannel, message };
}

export async function statusReminders(models) {
  const reminders = await models.StatusReminder.find().select('name time enabled notifyChannel message').lean();
  if (!reminders.some(({ _id }) => _id === defaultStatusReminder._id)) reminders.push(defaultStatusReminder);
  return reminders.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
}

export function parseDailyReport(value) {
  const { enabled, shiftStart, reminderAt } = value || {};
  if (typeof enabled !== 'boolean' || !validTime(shiftStart) || !validTime(reminderAt)) {
    throw new HttpError(400, 'Enter a shift start and submission reminder time');
  }
  if (enabled && reminderAt < shiftStart) throw new HttpError(400, 'Choose a reminder time at or after the shift starts');
  return { enabled, shiftStart, reminderAt };
}

export function dailyReportSettings(settings, legacy) {
  if (settings) return settings;
  const late = legacy?.shift === 'afternoon';
  return { enabled: !!legacy?.enrolled, shiftStart: late ? '15:00' : '09:00', reminderAt: late ? '15:30' : '10:00' };
}

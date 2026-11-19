import { HttpError } from '../middleware/auth.js';

export const validTime = (time) => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

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

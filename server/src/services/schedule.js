import { HttpError } from '../middleware/auth.js';

// “Biweekly” with two chosen dates means twice per month, not every 14 days.
export function scheduleFields(body) {
  const { frequency } = body;
  if (!['daily', 'weekly', 'monthly', 'semimonthly'].includes(frequency)) throw new HttpError(400, 'Invalid frequency');
  const integer = (value, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  const result = { frequency, weekday: undefined, weekdays: [], monthDay: undefined, monthDays: [] };
  if (frequency === 'weekly') {
    if (!integer(body.weekday, 0, 6)) throw new HttpError(400, 'Choose a weekday');
    result.weekday = Number(body.weekday);
    if (Array.isArray(body.weekdays) && body.weekdays.length) {
      if (!body.weekdays.every(d => integer(d, 0, 6))) throw new HttpError(400, 'Invalid weekdays');
      result.weekdays = [...new Set(body.weekdays.map(Number))];
    }
  }
  if (frequency === 'monthly') {
    if (!integer(body.monthDay, 1, 31)) throw new HttpError(400, 'Choose a monthly date from 1 to 31');
    result.monthDay = Number(body.monthDay);
  }
  if (frequency === 'semimonthly') {
    const days = body.monthDays;
    if (!Array.isArray(days) || days.length !== 2 || !days.every(d => integer(d, 1, 31)) || Number(days[0]) === Number(days[1])) {
      throw new HttpError(400, 'Choose two different dates from 1 to 31');
    }
    result.monthDays = days.map(Number).sort((a,b) => a-b);
  }
  if (body.startsOn !== undefined) {
    const start = new Date(body.startsOn);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid start date');
    result.startsOn = start;
  }
  return result;
}

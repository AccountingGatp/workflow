import { HttpError } from '../middleware/auth.js';

export const zone = 'Asia/Kolkata';
const localClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function clock(now = new Date()) {
  const [date, time] = localClock.format(now).split(' ');
  return { date, time, weekday: new Date(date).getUTCDay() };
}

export function dateValue(input) {
  if (typeof input !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(input)) throw new HttpError(400, 'Enter a valid date');
  const date = new Date(input);
  if (Number.isNaN(+date) || date.toISOString().slice(0, 10) !== input) throw new HttpError(400, 'Enter a valid date');
  return input;
}

export function shiftDate(date, days) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

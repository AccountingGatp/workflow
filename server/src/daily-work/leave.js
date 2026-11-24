import { randomUUID } from 'node:crypto';
import { shiftDate } from './dates.js';

export const leaveOverlap = (from, to) => ({ $or: [
  { period: { $ne: true }, date: { $gte: from, $lte: to } },
  { period: true, date: { $lte: to }, $or: [{ through: null }, { through: { $gte: from } }] },
] });

export async function leaveDates(Leave, from, to = from) {
  const records = await Leave.find(leaveOverlap(from, to)).select('memberId date through period').lean();

  const dates = new Set();
  for (const record of records) {
    const start = record.date < from ? from : record.date;
    const end = record.period ? (record.through || to) : record.date;
    for (let date = start; date <= end && date <= to; date = shiftDate(date, 1)) {
      dates.add(`${record.memberId}:${date}`);
    }
  }
  return dates;
}

export async function setCurrentLeave(Leave, memberId, date, onLeave) {
  const open = { memberId, period: true, through: null };
  if (onLeave) {
    await Leave.updateOne(open, { $setOnInsert: {
      _id: randomUUID(), date,
    }, $set: { memberId, period: true, through: null } }, { upsert: true })
      .catch((error) => { if (error.code !== 11000) throw error; });
    return;
  }
  await Leave.db.transaction(async (session) => {
    await Leave.updateOne(open, { $set: { through: shiftDate(date, -1) } }, { session });
    await Leave.deleteOne({ _id: `${memberId}:${date}` }, { session });
  });
}

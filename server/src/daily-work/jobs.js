import { dailyModels } from './models.js';
import { roster } from './access.js';
import { clock, shiftDate } from './dates.js';
import { postSlack, retrySlack, slackConfigured, submissionText } from './slack.js';

const activeDate = (member, date) => member.enrolled && (!member.reportFrom || member.reportFrom <= date);
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const validTime = (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || '');
const dayOf = (date) => new Date(date).getUTCDay();
const names = (members) => members.map((member) => member.name.replace(/[&<>]/g, '')).join(', ');

async function attendance(models, from, to = from) {
  const range = { $gte: from, $lte: to };
  const [members, entries, leave] = await Promise.all([
    roster({ members: null }, models),
    models.Submission.find({ date: range, 'entries.0': { $exists: true } }).lean(),
    models.Leave.find({ date: range }).lean(),
  ]);
  return { members, entries, leave: new Set(leave.map((row) => row._id)) };
}

async function missingText(models, date, shift, caption, allSubmitted = false) {
  const data = await attendance(models, date);
  const expected = data.members.filter((member) => activeDate(member, date) && (!shift || member.shift === shift) &&
    !data.leave.has(`${member.id}:${date}`));
  if (!expected.length) return null;
  const submitted = new Set(data.entries.map((entry) => entry.memberId));
  const missing = expected.filter((member) => !submitted.has(member.id));
  if (!missing.length) return allSubmitted ? '🎊 All employees submitted' : null;
  return `*${caption}* · ${date}\n${names(missing)}`;
}

async function weeklyText(models, date) {
  const from = shiftDate(date, -6);
  const data = await attendance(models, from, date);
  const rows = data.members.flatMap((member) => {
    const submitted = data.entries.filter((entry) => entry.memberId === member.id && activeDate(member, entry.date) &&
      !data.leave.has(entry._id));
    if (!submitted.length) return [];
    return `• ${names([member])} (${member.shift}): ${submitted.map((entry) => entry.date).sort().join(', ')}`;
  });
  return rows.length ? [`*Weekly Submission Report* · ${from} to ${date}`, ...rows].join('\n') : null;
}

async function incompleteText(models, date) {
  const data = await attendance(models, shiftDate(date, -6), date);
  const people = new Set(data.members.filter((member) => member.enrolled).map((member) => member.id));
  const rows = data.entries.filter((entry) => people.has(entry.memberId) && !data.leave.has(entry._id))
    .map((doc) => ({ ...doc, entries: doc.entries.filter((row) => row.status === 'incomplete') })).filter((doc) => doc.entries.length);
  return rows.length ? [`*Incomplete task report* · ${shiftDate(date, -6)} to ${date}`,
    ...rows.map((row) => submissionText(row, 'Incomplete tasks'))].join('\n\n') : null;
}

async function sendScheduled(models, key, now, compose) {
  const existing = await models.Report.findById(key).lean();
  if (existing && existing.state !== 'failed') return;
  const message = await compose();
  const startedAt = new Date(now);
  if (!existing) {
    try {
      await models.Report.create({ _id: key, state: 'sending', startedAt, expiresAt: new Date(+startedAt + 31 * 86400000) });
    } catch (error) {
      if (error.code === 11000) return;
      throw error;
    }
  } else {
    const result = await models.Report.updateOne({ _id: key, state: 'failed' }, { $set: { startedAt, state: 'sending' } });
    if (!result.modifiedCount) return;
  }
  let state = 'sent';
  try {
    if (message) await postSlack(message);
  } catch (error) {
    state = error.definite ? 'failed' : 'uncertain';
    console.error(`Daily Work Slack report ${key}: ${error.message}`);
  }
  await models.Report.updateOne({ _id: key }, { $set: { state } });
}

export async function runDailyWorkJobs(now = new Date()) {
  if (!slackConfigured()) return;
  const models = await dailyModels();
  await retrySlack(models);
  if (process.env.DAILY_WORK_SLACK_REPORTS !== 'true') return;
  const { date, time, weekday } = clock(now);
  const yesterday = shiftDate(date, -1);
  const reportDays = (process.env.DAILY_WORK_REPORT_DAYS || '1,2,3,4,5').split(',').map(Number);
  const weeklyDay = Number(process.env.DAILY_WORK_WEEKLY_DAY ?? 5);
  const jobs = [
    ['morning', '10:00', reportDays.includes(weekday), () => missingText(models, date, 'morning', 'Morning shift missing submissions')],
    ['afternoon', '15:30', reportDays.includes(weekday), () => missingText(models, date, 'afternoon', 'Afternoon shift missing submissions', true)],
    ['overnight', '01:00', reportDays.includes(dayOf(yesterday)), () => missingText(models, yesterday, null, 'Previous day missing submissions')],
    ['weekly', process.env.DAILY_WORK_WEEKLY_TIME || '18:00', weekday === weeklyDay, () => weeklyText(models, date)],
    ['incomplete', process.env.DAILY_WORK_INCOMPLETE_TIME || '18:15', reportDays.includes(weekday), () => incompleteText(models, date)],
  ];
  await Promise.all(jobs.filter(([, at, enabled]) => {
    if (!enabled || !validTime(at)) return false;
    const difference = minutes(time) - minutes(at);
    return difference >= 0 && difference < 25;
  }).map(([key, , , compose]) => sendScheduled(models, `${key}:${date}`, now, compose)));
}

import { dailyModels } from './models.js';
import { projectWorkflowStatuses } from './workflow-links.js';
import { roster } from './access.js';
import { clock, shiftDate } from './dates.js';
import { dailySubmissionText, postSlack, retrySlack, slackConfigured, slackPerson } from './slack.js';
import { validTime } from './settings.js';

const activeDate = (member, date) => member.enrolled && (!member.reportFrom || member.reportFrom <= date);
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const withinWindow = (time, at) => {
  if (!validTime(at)) return false;
  const difference = minutes(time) - minutes(at);
  return difference >= 0 && difference < 25;
};
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

async function missingText(models, date, reminderAt, allSubmitted = false) {
  const data = await attendance(models, date);
  const expected = data.members.filter((member) => activeDate(member, date) &&
    (!reminderAt || member.reminderAt === reminderAt) && !data.leave.has(`${member.id}:${date}`));
  if (!expected.length) return null;
  const submitted = new Set(data.entries.map((entry) => entry.memberId));
  const missing = expected.filter((member) => !submitted.has(member.id));
  if (!missing.length) return allSubmitted
    ? `:confetti_ball: All employees submitted their work details.\n:white_check_mark: Total submissions: ${expected.length}/${expected.length}`
    : null;
  const count = expected.length - missing.length;
  return [
    ':clipboard: *Missing Daily Work submissions*',
    `:date: Date: ${date}`,
    '',
    `:warning: ${missing.length} ${missing.length === 1 ? 'employee has' : 'employees have'} not submitted their work details:`,
    ...missing.map((member, index) => `${index + 1}. ${slackPerson(member.name, member.slackUserId)}`),
    '',
    ':bar_chart: *Summary*',
    `• Submitted: ${count}/${expected.length}`,
    `• Missing: ${missing.length}/${expected.length}`,
    `• Completion rate: ${Math.round(count * 100 / expected.length)}%`,
    '',
    'Please submit your Daily Work details.',
  ].join('\n');
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
  const data = await attendance(models, date);
  const members = data.members.filter((member) => activeDate(member, date) && !data.leave.has(`${member.id}:${date}`));
  if (!members.length) return null;
  const people = new Map(members.map((member) => [member.id, member]));
  const rows = (await projectWorkflowStatuses(data.entries)).filter((doc) => people.has(doc.memberId))
    .map((doc) => ({ ...doc, entries: doc.entries.filter((row) => row.status === 'incomplete' && row.workflowStatus !== 'pending_review') }))
    .filter((doc) => doc.entries.length);
  const heading = `:warning: *Incomplete Tasks Report*\nDate: ${date}`;
  if (!rows.length) return `${heading}\n\n:white_check_mark: No incomplete tasks reported.`;
  return [heading, ...rows.map((row) => dailySubmissionText(row, people.get(row.memberId).slackUserId, true))].join('\n\n');
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
  const { date, time, weekday } = clock(now);
  if (withinWindow(time, '18:35')) {
    await sendScheduled(models, `status-reminder:${date}`, now,
      () => '<!channel> Team, please update the work status of your tasks on Workflow.');
  }
  const allReports = process.env.DAILY_WORK_SLACK_REPORTS === 'true';
  if (!allReports && process.env.DAILY_WORK_SHIFT_REPORTS !== 'true') return;
  const yesterday = shiftDate(date, -1);
  const reportDays = (process.env.DAILY_WORK_REPORT_DAYS || '1,2,3,4,5').split(',').map(Number);
  const weeklyDay = Number(process.env.DAILY_WORK_WEEKLY_DAY ?? 5);
  const workday = reportDays.includes(weekday);
  const active = workday ? await roster({ members: null }, models) : [];
  const reminderTimes = new Set(active.filter((member) => activeDate(member, date)).map((member) => member.reminderAt));
  const reminders = [...reminderTimes].map((at) => {
    const key = at === '10:00' ? 'morning' : at === '15:30' ? 'afternoon' : `reminder:${at}`;
    return [key, at, workday, () => missingText(models, date, at, at === '15:30')];
  });
  const priorWorkday = reportDays.includes(dayOf(yesterday));
  const jobs = [
    ...reminders,
    ['overnight', '01:00', allReports && priorWorkday, () => missingText(models, yesterday)],
    ['weekly', process.env.DAILY_WORK_WEEKLY_TIME || '18:00', allReports && weekday === weeklyDay, () => weeklyText(models, date)],
    ['incomplete', process.env.DAILY_WORK_INCOMPLETE_TIME || '00:00', priorWorkday, () => incompleteText(models, yesterday)],
  ];
  await Promise.all(jobs.filter(([, at, enabled]) => enabled && withinWindow(time, at))
    .map(([key, , , compose]) => sendScheduled(models, `${key}:${date}`, now, compose)));
}

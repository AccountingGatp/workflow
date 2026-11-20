import { dailyModels } from './models.js';
import { projectWorkflowStatuses } from './workflow-links.js';
import { roster } from './access.js';
import { clock, shiftDate } from './dates.js';
import { leaveDates } from './leave.js';
import { dailySubmissionText, postSlack, retrySlack, slackConfigured, slackPerson, statusReminderText } from './slack.js';
import { statusReminders, validTime } from './settings.js';

const activeDate = (member, date) => member.enrolled && (!member.reportFrom || member.reportFrom <= date);
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const withinWindow = (time, at) => {
  if (!validTime(at)) return false;
  const difference = minutes(time) - minutes(at);
  return difference >= 0 && difference < 25;
};
const dayOf = (date) => new Date(date).getUTCDay();
const names = (members) => members.map((member) => member.name.replace(/[&<>]/g, '')).join(', ');

async function reportingRoster(models) {
  const members = await roster({ members: null }, models);
  return members.filter(({ role }) => role === 'employee' || role === 'admin');
}

async function attendance(models, from, to = from) {
  const range = { $gte: from, $lte: to };
  const [members, entries, leave] = await Promise.all([
    reportingRoster(models),
    models.Submission.find({ date: range, 'entries.0': { $exists: true } }).lean(),
    leaveDates(models.Leave, from, to),
  ]);
  return { members, entries, leave };
}

async function missingText(models, date, shift, at) {
  const data = await attendance(models, date);
  const expected = data.members.filter((member) => activeDate(member, date) &&
    member.shift === shift && member.shiftStart <= at && !data.leave.has(`${member.id}:${date}`));
  if (!expected.length) return `:clipboard: *${shift === 'morning' ? 'Morning' : 'Afternoon'} submissions report*\n:date: Date: ${date}\nNo employees were expected to submit at this check.`;
  const submitted = new Set(data.entries.map((entry) => entry.memberId));
  const missing = expected.filter((member) => !submitted.has(member.id));
  if (!missing.length) return `:confetti_ball: All employees submitted their work details.\n:white_check_mark: Total submissions: ${expected.length}/${expected.length}`;
  const count = expected.length - missing.length;
  return [
    ':clipboard: *Missing Daily Work submissions*',
    `:date: Date: ${date}`,
    ...(shift === 'afternoon' ? [':alarm_clock: 3:30 PM IST reminder'] : []),
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
  const from = shiftDate(date, -4);
  const data = await attendance(models, from, date);
  const rows = data.members.flatMap((member) => {
    const submitted = data.entries.filter((entry) => entry.memberId === member.id && activeDate(member, entry.date) &&
      !data.leave.has(entry._id));
    if (!submitted.length) return [];
    return `• ${names([member])} (${member.shift}): ${submitted.map((entry) => entry.date).sort().join(', ')}`;
  });
  return [`*Weekly Submission Report* · ${from} to ${date}`, ...(rows.length ? rows : ['No submissions recorded for this week.'])].join('\n');
}

async function incompleteText(models, date) {
  const data = await attendance(models, date);
  const members = data.members.filter((member) => activeDate(member, date) && !data.leave.has(`${member.id}:${date}`));
  const people = new Map(members.map((member) => [member.id, member]));
  const rows = (await projectWorkflowStatuses(data.entries)).filter((doc) => people.has(doc.memberId))
    .map((doc) => ({ ...doc, entries: doc.entries.filter((row) => row.status === 'incomplete' && row.workflowStatus !== 'pending_review') }))
    .filter((doc) => doc.entries.length);
  const heading = `:warning: *Incomplete Tasks Report*\nDate: ${date}`;
  if (!rows.length) return `${heading}\n\n:white_check_mark: No incomplete tasks reported.`;
  return [heading, ...rows.map((row) => dailySubmissionText(row, people.get(row.memberId).slackUserId, true)),
    'Please complete or update these tasks and contact your project manager if you need help.'].join('\n\n');
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
  const { date, time, weekday } = clock(now);
  const configured = await statusReminders(models);
  await Promise.all(configured.flatMap((reminder) => {
    const elapsed = (minutes(time) - minutes(reminder.time) + 1440) % 1440;
    if (!reminder.enabled || elapsed >= 25) return [];
    const reminderDate = time < reminder.time ? shiftDate(date, -1) : date;
    const day = dayOf(reminderDate);
    if (day < 1 || day > 5) return [];
    return sendScheduled(models, `${reminder._id}:${reminderDate}`, now, () => statusReminderText(reminder));
  }));
  await retrySlack(models);
  if (process.env.DAILY_WORK_SLACK_REPORTS === 'false') return;
  const yesterday = shiftDate(date, -1);
  const workday = weekday >= 1 && weekday <= 5;
  const jobs = [
    ['morning', '10:00', workday, () => missingText(models, date, 'morning', '10:00')],
    ['afternoon', '15:30', workday, () => missingText(models, date, 'afternoon', '15:30')],
    ['weekly', '17:30', weekday === 5, () => weeklyText(models, date)],
    ['incomplete', '00:00', true, () => incompleteText(models, yesterday)],
  ];
  await Promise.all(jobs.filter(([, at, enabled]) => enabled && withinWindow(time, at))
    .map(([key, , , compose]) => sendScheduled(models, `${key}:${date}`, now, compose)));
}

import { dailyModels } from './models.js';
import { projectWorkflowStatuses } from './workflow-links.js';
import { roster } from './access.js';
import { clock, shiftDate } from './dates.js';
import { leaveDates } from './leave.js';
import { dailySubmissionText, postSlack, retrySlack, slackConfigured, slackPerson, statusReminderText } from './slack.js';
import { automationByWorkItem } from '../services/task-automation.js';
import { statusReminders, validTime } from './settings.js';

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const withinWindow = (time, at) => {
  if (!validTime(at)) return false;
  const difference = minutes(time) - minutes(at);
  return difference >= 0 && difference < 25;
};
const dayOf = (date) => new Date(date).getUTCDay();
const deadlines = { morning: '10:00', afternoon: '15:30' };
const shiftLabel = { morning: '10:00 AM', afternoon: '3:30 PM' };
const reportRole = ({ role }) => role === 'employee' || role === 'admin';

async function reportingRoster(models, scope) {
  return (await roster(scope, models)).filter(reportRole);
}

async function attendance(models, from, to = from, scope = { members: null }) {
  const range = { $gte: from, $lte: to };
  const [members, entries, leave] = await Promise.all([
    reportingRoster(models, scope),
    models.Submission.find({ date: range, 'entries.0': { $exists: true } }).lean(),
    leaveDates(models.Leave, from, to),
  ]);
  return { members, entries, leave };
}

const eligible = (member, date, leave, enrolledOnly = true) =>
  (!enrolledOnly || member.enrolled) && (!member.reportFrom || member.reportFrom <= date) && !leave.has(`${member.id}:${date}`);

export async function missingSubmissions(models, date, { at = '23:59', shift, scope, enrolledOnly = true } = {}) {
  const { members, entries, leave } = await attendance(models, date, date, scope);
  const expected = members.filter((member) => eligible(member, date, leave, enrolledOnly) &&
    (!shift || member.shift === shift) && member.shiftStart <= at);
  const submitted = new Set(entries.map((entry) => entry.memberId));
  return { expected: expected.length, missing: expected.filter((member) => !submitted.has(member.id)) };
}

export function missingSubmissionText({ expected, missing }, date, shift) {
  const heading = [':clipboard: *List of employees who haven’t submitted their tasks*',
    `:date: Date: ${date}`, ...(shift ? [`:alarm_clock: ${shiftLabel[shift]} IST reminder`] : [])];
  if (!expected) return [...heading, '', 'No employees were expected to submit at this check.'].join('\n');
  if (!missing.length) return ':confetti_ball: *Excellent!* All employees have submitted their work details.';
  const count = expected - missing.length;
  return [
    ...heading, '',
    `:warning: *${missing.length}* ${missing.length === 1 ? 'employee has' : 'employees have'} not submitted their work details:`,
    ...missing.map((member, index) => `${index + 1}. ${slackPerson(member.name, member.slackUserId)}`),
    '',
    ':bar_chart: *Summary*',
    `• Submitted: ${count}/${expected}`,
    `• Missing: ${missing.length}/${expected}`,
    `• Completion rate: ${Math.round(count * 100 / expected)}%`,
    '',
    'Please submit your Daily Work details.',
  ].join('\n');
}

const missingText = async (models, date, shift) =>
  missingSubmissionText(await missingSubmissions(models, date, { shift, at: deadlines[shift] }), date, shift);

async function weeklyText(models, date) {
  const from = shiftDate(date, -4);
  const { members, entries, leave } = await attendance(models, from, date);
  const byMember = new Map(members.map((member) => [member.id, member]));
  const late = new Map();
  let onTime = 0;
  let checked = 0;
  for (const entry of entries) {
    const member = byMember.get(entry.memberId);
    if (!member || !entry.createdAt || !eligible(member, entry.date, leave)) continue;
    const deadline = member.shiftStart > deadlines[member.shift] ? member.shiftStart : deadlines[member.shift];
    const cutoff = new Date(`${entry.date}T${deadline}:00+05:30`);
    checked++;
    if (entry.createdAt <= cutoff) onTime++;
    else {
      if (!late.has(member)) late.set(member, []);
      late.get(member).push(entry.date);
    }
  }
  const heading = `*Weekly Submission Report* · ${from} to ${date}`;
  if (!checked) return `${heading}\nNo eligible submissions with a recorded save time this week.`;
  return [
    heading, '',
    `:white_check_mark: Submitted on time: ${onTime}/${checked}`,
    `:x: Saved after the deadline: ${checked - onTime}/${checked}`,
    ...(late.size ? ['', '*Employees who missed the deadline*', ...[...late]
      .sort(([a, daysA], [b, daysB]) => daysB.length - daysA.length || a.name.localeCompare(b.name))
      .map(([member, dates], i) =>
        `${i + 1}. ${slackPerson(member.name, member.slackUserId)} — ${dates.length} day(s)\n   Missed dates: ${dates.sort().join(', ')}`)] : []),
  ].join('\n');
}

async function incompleteText(models, date) {
  const data = await attendance(models, date);
  const members = data.members.filter((member) => eligible(member, date, data.leave));
  const people = new Map(members.map((member) => [member.id, member]));
  const submissions = data.entries.filter((doc) => people.has(doc.memberId));
  const rows = (await projectWorkflowStatuses(submissions)).map((doc) => ({ ...doc, entries: doc.entries.filter((row) => row.status === 'incomplete' && row.workflowStatus !== 'pending_review') }))
    .filter((doc) => doc.entries.length);
  const heading = `:warning: *Incomplete Tasks Report*\nDate: ${date}`;
  if (!submissions.length) return `${heading}\n\nNo eligible Daily Work submissions to check.`;
  if (!rows.length) return `${heading}\n\n:white_check_mark: No incomplete tasks reported.`;
  const automation = await automationByWorkItem(rows);
  return [heading, ...rows.map((row) => dailySubmissionText(row, people.get(row.memberId).slackUserId, true, automation)),
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
    if (message) await postSlack(`<!channel> ${message}`);
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
    ['morning', '10:00', workday, () => missingText(models, date, 'morning')],
    ['afternoon', '15:30', workday, () => missingText(models, date, 'afternoon')],
    ['weekly', '17:30', weekday === 5, () => weeklyText(models, date)],
    ['incomplete', '00:00', true, () => incompleteText(models, yesterday)],
  ];
  await Promise.all(jobs.filter(([, at, enabled]) => enabled && withinWindow(time, at))
    .map(([key, , , compose]) => sendScheduled(models, `${key}:${date}`, now, compose)));
}

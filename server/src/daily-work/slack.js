import { HttpError } from '../middleware/auth.js';
import { slackUserIdPattern, User } from '../models/index.js';

export const slackConfigured = () => !!(process.env.DAILY_WORK_SLACK_TOKEN && process.env.DAILY_WORK_SLACK_CHANNEL);
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const statusReminderText = ({ message }) => escape(message);

export function submissionText({ memberName, date, entries }, heading = 'Daily project update') {
  return [
    `*${heading}* · ${escape(memberName)} · ${date}`,
    ...entries.map((entry) => `• ${escape(entry.projectName)} — ${escape(entry.title)} · ${entry.hours} h · ${entry.priority} priority · ${entry.status}`),
    entries.length ? `Total: ${entries.reduce((sum, row) => sum + row.hours, 0).toFixed(2)} h` : 'All tasks removed for this day.',
  ].join('\n');
}

const calendarDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const priority = { low: 'Low', normal: 'Medium', high: 'High' };
const showHours = (value) => Number(value.toFixed(2));
const hoursLabel = (value) => `${value} ${value === 1 ? 'hour' : 'hours'}`;

function workDate(date) {
  const parts = Object.fromEntries(calendarDate.formatToParts(new Date(`${date}T00:00:00Z`)).map(({ type, value }) => [type, value]));
  const day = Number(parts.day);
  const suffix = day >= 11 && day <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[day % 10] || 'th';
  return `${parts.weekday}, ${parts.month} ${day}${suffix}, ${parts.year}`;
}

export const slackPerson = (name, id) =>
  id && slackUserIdPattern.test(id) ? `<@${id}>` : escape(name);

export function dailySubmissionText({ memberName, date, entries }, slackUserId, report = false) {
  const projects = new Map();
  for (const entry of entries) {
    const key = entry.projectId || entry.projectName;
    if (!projects.has(key)) projects.set(key, { name: entry.projectName, entries: [], hours: 0 });
    const group = projects.get(key);
    group.entries.push(entry);
    group.hours += entry.hours;
  }
  const lines = [
    report ? `Employee: ${slackPerson(memberName, slackUserId)}` :
      `${slackUserId && slackUserIdPattern.test(slackUserId) ? `<@${slackUserId}> ` : ''}Employee: ${escape(memberName)}`,
    ...(!report ? [`Date: ${workDate(date)}`] : []),
    `:bar_chart: Summary: ${projects.size} ${projects.size === 1 ? 'project' : 'projects'}, ${hoursLabel(showHours(entries.reduce((sum, entry) => sum + entry.hours, 0)))} total`,
  ];
  if (!projects.size) return [...lines, 'All tasks removed for this day.'].join('\n');
  lines.push('Projects:');
  for (const [index, project] of [...projects.values()].entries()) {
    lines.push(`${index + 1}. ${escape(project.name)} - ${hoursLabel(showHours(project.hours))}`);
    for (const [taskIndex, entry] of project.entries.entries()) {
      lines.push(`   Task ${taskIndex + 1}: ${escape(entry.title)} (${showHours(entry.hours)}h) - Priority: ${priority[entry.priority] || 'Medium'}`);
      if (entry.note && !report) lines.push(`      Note: ${escape(entry.note)}`);
      if (entry.incompleteReason && entry.status !== 'complete') lines.push(`      ${report ? 'Reason' : 'Incomplete'}: ${escape(entry.incompleteReason)}`);
    }
  }
  return lines.join('\n');
}

export async function postSlack(text, { channel = process.env.DAILY_WORK_SLACK_CHANNEL, thread, userError = false } = {}) {
  if (text.length > 39000) throw new HttpError(400, 'Slack report is too long. Choose a narrower filter.');
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.DAILY_WORK_SLACK_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text, ...(thread && { thread_ts: thread, reply_broadcast: false }), unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(8500),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || !data.ts) {
    const error = new HttpError(502, userError ? 'Slack could not confirm the post' : 'Slack delivery failed');
    error.definite = response.status === 429 || (response.ok && data?.ok === false && data.error !== 'internal_error');
    error.retrySeconds = Math.max(60, Number(response.headers.get('retry-after')) || 0);
    throw error;
  }
  return data;
}

export async function deliverSubmission({ Submission }, id) {
  if (!slackConfigured()) return Submission.findById(id);
  const now = new Date();
  const sending = await Submission.findOneAndUpdate({
    _id: id, delivery: { $in: ['pending', 'failed'] }, deliveryAfter: { $lte: now },
  }, { $set: { delivery: 'sending', deliveryAt: now }, $inc: { __v: 1 } }, { returnDocument: 'after' });
  if (!sending) return Submission.findById(id);
  const filter = { _id: id, __v: sending.__v, delivery: 'sending' };
  let result;
  try {
    const member = sending.slackTs ? null : await User.findById(sending.memberId).select('+slackUserId').lean();
    result = await postSlack(dailySubmissionText(sending, member?.slackUserId), {
      channel: sending.slackChannel, thread: sending.slackTs,
    });
  } catch (error) {
    return Submission.findOneAndUpdate(filter, { $set: {
      delivery: error.definite ? 'failed' : 'uncertain',
      deliveryAfter: new Date(+now + (error.retrySeconds || 60) * 1000),
    } }, { returnDocument: 'after' });
  }
  return Submission.findOneAndUpdate(filter, { $set: {
    delivery: 'sent',
    slackChannel: sending.slackChannel || result.channel || process.env.DAILY_WORK_SLACK_CHANNEL,
    slackTs: sending.slackTs || result.ts,
  } }, { returnDocument: 'after' });
}

export async function retrySlack(models) {
  if (!slackConfigured()) return;
  const now = new Date();
  await models.Submission.updateMany({
    delivery: 'sending', deliveryAt: { $lt: new Date(+now - 30000) },
  }, { $set: { delivery: 'uncertain' }, $inc: { __v: 1 } });
  const due = await models.Submission.find({
    delivery: { $in: ['pending', 'failed'] }, deliveryAfter: { $lte: now },
  }).select('_id').sort('deliveryAfter').limit(4).lean();
  for (const { _id } of due) await deliverSubmission(models, _id);
}

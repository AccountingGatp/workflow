import { HttpError } from '../middleware/auth.js';

export const slackConfigured = () => !!(process.env.DAILY_WORK_SLACK_TOKEN && process.env.DAILY_WORK_SLACK_CHANNEL);
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function submissionText({ memberName, date, entries }, heading = 'Daily project update', includeNotes = false) {
  return [
    `*${heading}* · ${escape(memberName)} · ${date}`,
    ...entries.map((entry) => `• ${escape(entry.projectName)} — ${escape(entry.title)} · ${entry.hours} h · ${entry.priority} priority · ${entry.workflowStatus === 'pending_review' ? 'awaiting TL review' : entry.status}${includeNotes && entry.note ? `\n  Note: ${escape(entry.note)}` : ''}${includeNotes && entry.incompleteReason && entry.status !== 'complete' ? `\n  Incomplete: ${escape(entry.incompleteReason)}` : ''}`),
    entries.length ? `Total: ${entries.reduce((sum, row) => sum + row.hours, 0).toFixed(2)} h` : 'All tasks removed for this day.',
  ].join('\n');
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
    result = await postSlack(submissionText(sending, sending.slackTs ? 'Updated daily project details' : 'Daily project update', true), {
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

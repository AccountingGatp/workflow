import { createHmac, randomUUID } from 'node:crypto';
import { HttpError, JWT_SECRET } from '../middleware/auth.js';
import { isSuper } from '../services/access.js';
import { clock, dateValue, shiftDate } from './dates.js';
import { dailyModels, sharedBudgetId } from './models.js';

const maxSubmissions = 200;

function cleanupFilter(user, { memberIds, from, to }) {
  if (!isSuper(user)) throw new HttpError(403, 'Only Super Admins can remove Daily Work activity');
  dateValue(from);
  dateValue(to);
  if (from > to || to >= clock().date || to > shiftDate(from, 365)) {
    throw new HttpError(400, 'Choose a historical work-date range of up to 366 days in IST');
  }
  return { date: { $gte: from, $lte: to }, memberId: { $in: [...new Set(memberIds)].sort() } };
}

async function matchingSubmissions(Submission, filter, session) {
  const matches = await Submission.find(filter).sort({ date: 1, memberId: 1, _id: 1 })
    .limit(maxSubmissions + 1).session(session || null).lean();
  if (matches.length > maxSubmissions) throw new HttpError(400, 'Narrow the range to at most 200 submissions');
  return matches;
}

function previewToken(user, filter, matches) {
  return createHmac('sha256', JWT_SECRET)
    .update(JSON.stringify({ purpose: 'daily-work-cleanup', user: String(user._id), filter, matches }))
    .digest('hex');
}

export async function previewDailyWorkCleanup(user, selection) {
  const filter = cleanupFilter(user, selection);
  const { Submission } = await dailyModels();
  const matches = await matchingSubmissions(Submission, filter);
  return {
    from: selection.from, to: selection.to,
    submissionCount: matches.length, entryCount: matches.reduce((sum, row) => sum + row.entries.length, 0),
    sendingCount: matches.filter((row) => row.delivery === 'sending').length,
    submissions: matches.map(({ memberId, memberName, date, entries }) => ({ memberId, memberName, date, entryCount: entries.length })),
    confirmationToken: matches.length ? previewToken(user, filter, matches) : null,
  };
}

export async function deleteDailyWorkActivity(user, selection, token) {
  const filter = cleanupFilter(user, selection);
  const { Submission, SubmissionArchive, BudgetRevision } = await dailyModels();
  const cleanupId = randomUUID();
  return Submission.db.transaction(async (session) => {
    const matches = await matchingSubmissions(Submission, filter, session);
    if (!matches.length || token !== previewToken(user, filter, matches)) {
      throw new HttpError(409, 'The selected activity has changed. Preview it again before deleting.');
    }
    if (matches.some(({ delivery }) => delivery === 'sending')) {
      throw new HttpError(409, 'Slack delivery is in progress. Wait and preview the activity again.');
    }
    // Serialize with Daily Work saves that check shared hour budgets.
    await BudgetRevision.updateOne({ _id: sharedBudgetId }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SubmissionArchive.insertMany(matches.map((submission) => ({
      cleanupId, actor: user._id, archivedAt: new Date(), submission,
    })), { session });
    const result = await Submission.deleteMany({ _id: { $in: matches.map(({ _id }) => _id) } }).session(session);
    if (result.deletedCount !== matches.length) throw new HttpError(409, 'The selected activity has changed');
    return {
      cleanupId, from: selection.from, to: selection.to, deletedSubmissions: result.deletedCount,
      deletedEntries: matches.reduce((sum, row) => sum + row.entries.length, 0),
    };
  });
}

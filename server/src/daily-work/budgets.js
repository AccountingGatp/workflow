import { User } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { shiftDate } from './dates.js';

export const periodLimits = { daily: 24, weekly: 168, monthly: 744 };
export const catalogCollation = { locale: 'en', strength: 2 };
const reviewNames = ['simran', 'krupali', 'jaini', 'riddhi'];
const reviewKey = 'review';
const cents = (hours) => Math.round(hours * 100);
export const taskName = (value) => value.trim().toLocaleLowerCase('en');
export const isReview = (title) => taskName(title) === 'review';

export async function canLogReview(user) {
  const first = taskName(user.name).split(/\s+/)[0];
  if (user.role !== 'admin' || !reviewNames.includes(first)) return false;
  const matching = await User.find({ role: 'admin', active: true, name: new RegExp(`^\\s*${first}(?:\\s|$)`, 'i') })
    .select('_id').limit(2).lean();
  return matching.length === 1 && String(matching[0]._id) === String(user._id);
}

export async function ensureReviewCatalog({ CatalogTask }, projects, session) {
  if (!projects.length) return;
  const operations = projects.map((project) => ({
    updateOne: {
      filter: { projectId: String(project._id), title: 'Review' },
      collation: catalogCollation,
      update: { $set: { title: 'Review', period: 'daily', hours: 1, archived: false } },
      upsert: true, timestamps: false,
    },
  }));
  try {
    await CatalogTask.bulkWrite(operations, { ordered: false, session });
  } catch (error) {
    if (session || error.code !== 11000 || error.writeErrors?.some((item) => item.code !== 11000)) throw error;
    await CatalogTask.bulkWrite(operations.map(({ updateOne }) => ({ updateOne: { ...updateOne, upsert: false } })));
  }
}

export function periodBounds(date, period) {
  if (period === 'daily') return [date, date];
  if (period === 'weekly') {
    const weekday = new Date(date).getUTCDay();
    const monday = shiftDate(date, -((weekday + 6) % 7));
    return [monday, shiftDate(monday, 6)];
  }
  const first = date.slice(0, 7) + '-01';
  const nextMonth = new Date(first);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return [first, shiftDate(nextMonth.toISOString().slice(0, 10), -1)];
}

export function taskBudget(task, date) {
  if (isReview(task.title)) return { key: reviewKey, start: date, end: date, period: 'daily', hours: 1, title: 'Review' };
  const period = task.period || 'daily';
  const [start, end] = periodBounds(date, period);
  return { key: String(task._id), start, end, period, hours: task.hours, title: task.title };
}

function entryKeys(entry, matching) {
  if (isReview(entry.title)) return [reviewKey];
  const linked = entry.catalogId;
  const named = matching.get(`${entry.projectId}:${taskName(entry.title)}`);
  return [...new Set([linked, entry.workItemId, named].filter(Boolean))];
}

function entryTotals(entries, names) {
  const totals = new Map();
  for (const row of entries) {
    for (const key of entryKeys(row, names)) totals.set(key, (totals.get(key) || 0) + cents(row.hours));
  }
  return totals;
}

function catalogNames(catalog) {
  return new Map(catalog.filter((task) => !isReview(task.title))
    .map((task) => [`${task.projectId}:${taskName(task.title)}`, String(task._id)]));
}

async function periodUsage(models, memberId, date, catalog, session) {
  const budgets = new Map(catalog.map((task) => {
    const budget = taskBudget(task, date);
    return [budget.key, { ...budget, spent: 0 }];
  }));
  const ranged = [...budgets.values()].filter(({ period }) => period !== 'daily');
  if (!ranged.length) return budgets;
  const start = ranged.map((budget) => budget.start).sort()[0];
  const end = ranged.map((budget) => budget.end).sort().at(-1);
  const rows = await models.Submission.find({ memberId, date: { $gte: start, $lte: end, $ne: date } })
    .select('date entries').session(session || null).lean();
  const names = catalogNames(catalog);
  for (const row of rows) {
    for (const [key, hours] of entryTotals(row.entries, names)) {
      const budget = budgets.get(key);
      if (budget && row.date >= budget.start && row.date <= budget.end) budget.spent += hours;
    }
  }
  return budgets;
}

export function withClientBudgets(catalog, workItems) {
  const configured = catalogNames(catalog.filter((task) => !task.archived));
  return [...catalog, ...workItems.filter((item) => item.period && item.hours != null &&
    !configured.has(`${item.projectId}:${taskName(item.title)}`)).map((item) => ({
    _id: item.id, projectId: item.projectId, title: item.title, hours: item.hours, period: item.period, workItemId: item.id,
  }))];
}

export async function catalogAvailability(models, memberId, date, catalog) {
  const budgets = await periodUsage(models, memberId, date, catalog);
  return catalog.map((task) => {
    const { period, hours, spent, start, end } = budgets.get(taskBudget(task, date).key);
    return { ...task, period, hours, remainingHours: Math.max(0, cents(hours) - spent) / 100,
      periodStart: start, periodEnd: end, review: isReview(task.title) };
  });
}

export async function validateBudgets(models, memberId, date, catalog, saved, prior, session) {
  const names = catalogNames(catalog);
  const before = entryTotals(prior, names);
  const totals = entryTotals(saved, names);
  const touched = catalog.filter((task) => totals.has(taskBudget(task, date).key));
  const budgets = await periodUsage(models, memberId, date, touched, session);
  for (const [key, budget] of budgets) {
    const available = Math.max(0, cents(budget.hours) - budget.spent);
    const logged = totals.get(key);
    if (logged > available && logged > (before.get(key) || 0)) {
      throw new HttpError(400, `${budget.title} exceeds its ${budget.period} limit. Up to ${available / 100} h can be entered for this date.`);
    }
  }
}

import { Router } from 'express';
import mongoose from 'mongoose';
import { HttpError, ah } from '../middleware/auth.js';
import { User } from '../models/index.js';
import { isSuper } from '../services/access.js';
import { dailyModels } from './models.js';
import { importDailyProjects } from './import-projects.js';
import { dailyScope, includes, roster, validateProjectLink, workflowProjects, workflowSuggestions } from './access.js';
import { canLogReview, catalogAvailability, catalogCollation, ensureReviewCatalog, isReview, periodLimits, taskName, validateBudgets } from './budgets.js';
import { clock, dateValue, shiftDate } from './dates.js';
import { deliverSubmission, postSlack, submissionText, slackConfigured } from './slack.js';
import { hubstaff, hubstaffConfigured } from './hubstaff.js';

const r = Router();
const fail = (message) => { throw new HttpError(400, message); };
const idValue = (id) => {
  if (typeof id !== 'string' || !mongoose.isObjectIdOrHexString(id)) fail('Select a valid record');
  return id;
};
const textValue = (value, max, required = true) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max || (required && !text)) fail(`Enter text up to ${max} characters`);
  return text;
};
const hoursValue = (value, limit = 24) => {
  if (value == null || !['number', 'string'].includes(typeof value) || !String(value).trim()) fail(`Enter hours between 0 and ${limit}`);
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > limit) fail(`Enter hours between 0 and ${limit}`);
  return Math.round(hours * 100) / 100;
};
const enforce = (access) => { if (!access) throw new HttpError(403, 'You do not have permission for this'); };
const scoped = (ids) => ids === null ? {} : { clientId: { $in: ids } };
const reportMember = (member, date) => member.enrolled && (!member.reportFrom || member.reportFrom <= date);
const route = (handler, superOnly = false) => ah(async (req, res) => {
  if (superOnly) enforce(isSuper(req.user));
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body ??= {};
  const [models, scope] = await Promise.all([dailyModels(), dailyScope(req.user)]);
  await handler(req, res, models, scope);
});

async function projectInScope(models, scope, id, managing = false, session) {
  const project = await models.Project.findById(idValue(id)).session(session || null);
  if (!project) throw new HttpError(404, 'Daily Work project not found');
  enforce(includes(managing ? scope.managed : scope.visible, project.clientId));
  return project;
}

function publicSubmission(doc, entries = doc.entries) {
  return {
    id: doc._id, date: doc.date, memberId: doc.memberId, memberName: doc.memberName, entries,
    version: doc.__v, delivery: doc.delivery,
  };
}

r.get('/day/:date', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  const memberId = scope.own;
  const [projects, submission, assignments, settings] = await Promise.all([
    models.Project.find({ ...scoped(scope.visible), archived: false }).sort('name').lean(),
    models.Submission.findById(`${memberId}:${date}`).lean(),
    models.Assignment.find({ memberId }).lean(),
    models.Member.findById(memberId).lean(),
  ]);
  const [catalog, suggestions, reviewAllowed] = await Promise.all([
    models.CatalogTask.find({ projectId: { $in: projects.map((project) => project._id) }, archived: false }).sort('title').lean(),
    workflowSuggestions(scope, memberId, date, projects),
    canLogReview(req.user),
  ]);
  res.json({
    date, projects,
    catalog: await catalogAvailability(models, memberId, date, catalog.filter((task) => reviewAllowed || !isReview(task.title))),
    suggestions: suggestions.filter((task) => !isReview(task.title)),
    assignments, memberName: req.user.name,
    submission: submission && publicSubmission(submission, submission.entries.filter((entry) => includes(scope.visible, entry.clientId))),
    slackEnabled: slackConfigured(),
    hubstaffAccess: isSuper(req.user) || !!settings?.hubstaffAccess,
  });
}));

r.put('/day/:date', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  if (date > clock().date) fail('Daily work cannot be submitted for a future date');
  const { entries, version } = req.body;
  if (!Array.isArray(entries) || entries.length > 40) fail('Enter up to 40 tasks for the day');
  if (entries.some((entry) => !entry || typeof entry !== 'object')) fail('Enter a valid task');

  const key = `${scope.own}:${date}`;
  const reviewAllowed = await canLogReview(req.user);
  await models.BudgetRevision.updateOne({ _id: scope.own }, { $setOnInsert: { revision: 0 } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });

  const { submission, changed } = await models.Submission.db.transaction(async (session) => {
    // Serialize this member's saves across dates, so two concurrent days cannot spend the same hours.
    await models.BudgetRevision.updateOne({ _id: scope.own }, { $inc: { revision: 1 } }, { session });
    return saveDay(req.user, models, scope, { date, key, entries, version, reviewAllowed, session });
  });
  const result = changed ? await deliverSubmission(models, key) : submission;
  res.json(publicSubmission(result, result.entries.filter((entry) => includes(scope.visible, entry.clientId))));
}));

async function saveDay(user, models, scope, { date, key, entries, version, reviewAllowed, session }) {
  const previous = await models.Submission.findById(key).session(session);
  if ((previous && previous.__v !== version) || (!previous && version != null)) {
    throw new HttpError(409, 'This submission changed. Refresh before saving again.');
  }
  if (previous?.delivery === 'sending' && Date.now() - previous.deliveryAt < 30000) {
    throw new HttpError(409, 'Slack delivery is in progress. Try again in a moment.');
  }
  if (!previous && !entries.length) fail('Add at least one task');
  const projectIds = [...new Set([...entries, ...(previous?.entries || [])].map((entry) => idValue(entry.projectId)))];
  const catalog = await models.CatalogTask.find({ projectId: { $in: projectIds } }).session(session).lean();
  const saved = [];
  for (const input of entries) {
    const existing = input._id && previous?.entries.id(idValue(input._id));
    if (input._id && !existing) fail('A task has changed. Refresh before saving again.');
    if (existing && saved.some((row) => String(row._id) === input._id)) fail('Each task can only be included once');
    const sameProject = !!existing && existing.projectId === input.projectId;
    const project = sameProject ? null : await projectInScope(models, scope, input.projectId, false, session);
    if (project?.archived) fail('Select an active project');
    const projectId = String(project?._id || existing.projectId);
    const clientId = project?.clientId || existing.clientId;
    if (!includes(scope.visible, clientId)) {
      if (existing && sameProject) { saved.push(existing.toObject()); continue; }
      enforce(false);
    }

    const enteredTitle = textValue(input.title, 230);
    const hours = hoursValue(input.hours);
    const { priority, status } = input;
    if (!['low', 'normal', 'high'].includes(priority) || !['incomplete', 'complete'].includes(status)) fail('Choose a valid status and priority');
    const projectCatalog = catalog.filter((item) => item.projectId === projectId);
    const namedTask = projectCatalog.find((item) => taskName(item.title) === taskName(enteredTitle));
    let catalogTask = namedTask;
    if (input.catalogId) {
      catalogTask = projectCatalog.find((item) => String(item._id) === idValue(input.catalogId));
      if (!catalogTask) fail('Select a task from this project');
      if (namedTask && namedTask !== catalogTask) fail('Select the saved task that matches this name');
    }
    const isExistingTask = sameProject && catalogTask &&
      (String(catalogTask._id) === existing.catalogId || taskName(catalogTask.title) === taskName(existing.title));
    if (catalogTask?.archived && !isExistingTask) fail('Select an active catalog task');
    const title = catalogTask?.title || enteredTitle;
    if (isReview(title) && !reviewAllowed) {
      if (!sameProject || !isReview(existing.title) || hours > existing.hours) {
        throw new HttpError(403, 'Only Simran, Krupali, Jaini and Riddhi can log Review hours');
      }
    }
    let workflowTaskId;
    if (input.workflowTaskId && !isReview(title)) {
      workflowTaskId = idValue(input.workflowTaskId);
      if (!(sameProject && existing.workflowTaskId === workflowTaskId)) {
        const sourceProject = project || await projectInScope(models, scope, projectId, false, session);
        const suggestions = await workflowSuggestions(scope, scope.own, date, [sourceProject]);
        if (!suggestions.some((suggestion) => String(suggestion.id) === workflowTaskId)) fail('Select an available Workflow suggestion');
      }
    }
    saved.push({
      ...(existing && { _id: existing._id }),
      projectId, clientId, projectName: project?.name || existing.projectName,
      title, hours, priority, status, catalogId: catalogTask && String(catalogTask._id), workflowTaskId,
    });
  }
  // A full-day save cannot remove entries for a client whose access was revoked.
  for (const existing of previous?.entries || []) {
    if (!includes(scope.visible, existing.clientId) && !saved.some((row) => String(row._id) === String(existing._id))) {
      saved.push(existing.toObject());
    }
  }
  const submission = previous || new models.Submission({ _id: key, memberId: scope.own, date });
  const initial = !previous;
  if (!initial && JSON.stringify(saved.map(comparableEntry)) === JSON.stringify(previous.entries.map(comparableEntry))) {
    return { submission, changed: false };
  }
  await validateBudgets(models, scope.own, date, catalog, saved, previous?.entries || [], session);
  submission.memberName = user.name;
  submission.entries = saved;
  submission.delivery = slackConfigured() && (initial || submission.slackTs) ? 'pending' : 'skipped';
  submission.deliveryAfter = new Date();
  submission.deliveryAt = undefined;
  await submission.save({ session });
  return { submission, changed: true };
}

function comparableEntry(entry) {
  return ['_id', 'projectId', 'catalogId', 'workflowTaskId', 'title', 'hours', 'priority', 'status'].map((field) => String(entry[field] ?? ''));
}

async function reportRows(req, models, scope) {
  const from = dateValue(req.query.from || clock().date);
  const to = dateValue(req.query.to || from);
  if (to < from || to > shiftDate(from, 30)) fail('Select a date range of up to 31 days');
  const filter = { date: { $gte: from, $lte: to } };
  if (req.query.memberId) {
    const memberId = idValue(req.query.memberId);
    enforce(includes(scope.members, memberId));
    filter.memberId = memberId;
  } else if (scope.members !== null) filter.memberId = { $in: scope.members };
  const documents = await models.Submission.find(filter).sort({ date: -1, memberName: 1 }).lean();
  return documents.flatMap((doc) => {
    const scopeIds = doc.memberId === scope.own ? scope.visible : scope.managed;
    const entries = doc.entries.filter((entry) => includes(scopeIds, entry.clientId) &&
      (!req.query.projectId || entry.projectId === req.query.projectId) &&
      (!req.query.status || entry.status === req.query.status));
    return entries.length ? [publicSubmission(doc, entries)] : [];
  });
}

r.get('/reports', route(async (req, res, models, scope) => {
  const [submissions, members, projects] = await Promise.all([
    reportRows(req, models, scope), roster(scope, models, true),
    models.Project.find(scoped(scope.visible)).sort('name').lean(),
  ]);
  res.json({ submissions, members: members.map(({ id, name }) => ({ id, name })), projects, slackEnabled: slackConfigured() });
}));

r.post('/reports/slack', route(async (req, res, models, scope) => {
  const submissions = await reportRows(req, models, scope);
  if (!submissions.length) fail('No daily work matches these filters');
  if (!slackConfigured()) throw new HttpError(503, 'Slack is not configured');
  await postSlack(['Project Summary by Member', ...submissions.map((submission) => submissionText(submission))]
    .join('\n\n'), { userError: true });
  res.json({ ok: true });
}));

r.get('/missing/:date', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  const [members, submitted, leave] = await Promise.all([
    roster(scope, models),
    models.Submission.distinct('memberId', { date, 'entries.0': { $exists: true } }),
    models.Leave.distinct('memberId', { date }),
  ]);
  const expected = members.filter((member) => reportMember(member, date) && !leave.includes(member.id));
  res.json({ expected: expected.length, missing: expected.filter((member) => !submitted.includes(member.id))
    .map(({ id, name, shift }) => ({ id, name, shift })) });
}));

r.get('/manage', route(async (req, res, models, scope) => {
  const [workflow, projects, members, leave] = await Promise.all([
    workflowProjects(scope), models.Project.find(scoped(scope.managed)).sort('name').lean(), roster(scope, models),
    models.Leave.find({ date: { $gte: shiftDate(clock().date, -31) }, ...(scope.members !== null && { memberId: { $in: scope.members } }) }).sort('date').lean(),
  ]);
  const projectIds = projects.map((project) => project._id);
  const [catalog, assignments] = await Promise.all([
    models.CatalogTask.find({ projectId: { $in: projectIds } }).sort('title').lean(),
    models.Assignment.find({ projectId: { $in: projectIds }, ...(scope.members !== null && { memberId: { $in: scope.members } }) }).lean(),
  ]);
  res.json({ ...workflow, dailyProjects: projects, members, catalog, assignments, leave });
}, true));

r.post('/projects/import', route(async (req, res, models) => {
  res.json(await importDailyProjects(models, req.body.text));
}, true));

r.post('/projects', route(async (req, res, models, scope) => {
  const clientId = idValue(req.body.clientId);
  const workflowProjectId = req.body.workflowProjectId ? idValue(req.body.workflowProjectId) : undefined;
  await validateProjectLink(scope, clientId, workflowProjectId);
  const name = textValue(req.body.name, 120);
  const project = await models.Project.db.transaction(async (session) => {
    const [created] = await models.Project.create([{ clientId, workflowProjectId, name }], { session });
    await ensureReviewCatalog(models, [created], session);
    return created;
  });
  res.status(201).json(project);
}, true));

r.patch('/projects/:id', route(async (req, res, models, scope) => {
  const project = await projectInScope(models, scope, req.params.id, true);
  if (req.body.name !== undefined) project.name = textValue(req.body.name, 120);
  if (typeof req.body.archived === 'boolean') project.archived = req.body.archived;
  res.json(await project.save());
}, true));

function catalogFields(input, fallbackPeriod = 'daily') {
  if (!input || typeof input !== 'object') fail('Enter task details');
  const title = textValue(input.title, 230);
  if (isReview(title)) fail('Review is added automatically with a one-hour daily limit');
  const period = input.period ?? fallbackPeriod;
  if (!Object.hasOwn(periodLimits, period)) fail('Choose a daily, weekly or monthly limit');
  return { title, period, description: textValue(input.description, 800, false), hours: hoursValue(input.hours, periodLimits[period]) };
}

r.post('/projects/:id/catalog', route(async (req, res, models, scope) => {
  const project = await projectInScope(models, scope, req.params.id, true);
  if (project.archived) fail('Restore this project before adding catalog tasks');
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  if (!items.length || items.length > 200) fail('Enter between 1 and 200 tasks');
  const valid = items.map((item) => catalogFields(item));
  const titles = new Set(valid.map(({ title }) => title.toLocaleLowerCase('en')));
  if (titles.size !== valid.length) fail('Each task name in the import must be unique');
  const projectId = String(project._id);
  await models.CatalogTask.bulkWrite(valid.map((item) => ({ updateOne: {
    filter: { projectId, title: item.title }, collation: catalogCollation,
    update: { $set: { ...item, archived: false }, $setOnInsert: { projectId } }, upsert: true,
  } })));
  res.status(201).json({ saved: valid.length });
}, true));

r.patch('/catalog/:id', route(async (req, res, models, scope) => {
  const item = await models.CatalogTask.findById(idValue(req.params.id));
  if (!item) throw new HttpError(404, 'Catalog task not found');
  await projectInScope(models, scope, item.projectId, true);
  if (isReview(item.title)) fail('Review has a fixed one-hour daily limit');
  if (['title', 'description', 'hours', 'period'].some((field) => req.body[field] !== undefined)) {
    item.set(catalogFields({ title: item.title, description: item.description, hours: item.hours, ...req.body }, item.period));
  }
  if (typeof req.body.archived === 'boolean') item.archived = req.body.archived;
  res.json(await item.save());
}, true));

r.put('/projects/:id/members/:memberId', route(async (req, res, models, scope) => {
  const project = await projectInScope(models, scope, req.params.id, true);
  const memberId = idValue(req.params.memberId);
  enforce(includes(scope.members, memberId));
  if (!(await User.exists({ _id: memberId, active: true }))) fail('Select an active employee');
  const projectId = String(project._id);
  const _id = `${projectId}:${memberId}`;
  if (req.body.remove === true) await models.Assignment.deleteOne({ _id });
  else await models.Assignment.updateOne({ _id }, { $set: { projectId, memberId, hours: hoursValue(req.body.hours) } }, { upsert: true });
  res.json({ ok: true });
}, true));

r.put('/members/:id', route(async (req, res, models, scope) => {
  const _id = idValue(req.params.id);
  enforce(includes(scope.members, _id));
  if (!(await User.exists({ _id, active: true }))) fail('Select an active employee');
  const { enrolled, shift, reportFrom, hubstaffAccess, hubstaffUserId } = req.body;
  if (!['morning', 'afternoon'].includes(shift) || typeof enrolled !== 'boolean') fail('Choose a reporting setting and shift');
  const settings = { enrolled, shift, reportFrom: reportFrom ? dateValue(reportFrom) : null };
  if (isSuper(req.user)) {
    if (hubstaffUserId && !/^\d{1,16}$/.test(hubstaffUserId)) fail('Enter a numeric Hubstaff user ID');
    settings.hubstaffAccess = hubstaffAccess === true;
    settings.hubstaffUserId = hubstaffUserId || null;
  }
  await models.Member.updateOne({ _id }, { $set: settings }, { upsert: true });
  res.json({ ok: true });
}, true));

r.put('/members/:id/leave/:date', route(async (req, res, models, scope) => {
  const memberId = idValue(req.params.id);
  enforce(includes(scope.members, memberId));
  if (!(await User.exists({ _id: memberId, active: true }))) fail('Select an active employee');
  const date = dateValue(req.params.date);
  const _id = `${memberId}:${date}`;
  if (req.body.remove === true) await models.Leave.deleteOne({ _id });
  else await models.Leave.updateOne({ _id }, { $set: { memberId, date } }, { upsert: true });
  res.json({ ok: true });
}, true));

r.get('/hubstaff/:date', route(async (req, res, models, scope) => {
  const settings = await models.Member.findById(scope.own).lean();
  enforce(isSuper(req.user) || settings?.hubstaffAccess);
  if (!hubstaffConfigured()) throw new HttpError(503, 'Hubstaff is not configured');
  const date = dateValue(req.params.date);
  const members = (await roster(scope, models)).filter((member) => member.hubstaffUserId);
  res.json({ rows: await hubstaff(date, members) });
}));

export default r;

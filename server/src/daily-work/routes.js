import { Router } from 'express';
import mongoose from 'mongoose';
import { HttpError, ah } from '../middleware/auth.js';
import { ClientProject, Task, User } from '../models/index.js';
import { applyTaskTransition } from '../services/task-review.js';
import { isSuper } from '../services/access.js';
import { dailyModels } from './models.js';
import { importDailyProjects } from './import-projects.js';
import { dailyScope, includes, roster, validateProjectLink, workflowProjects } from './access.js';
import { canLogReview, catalogAvailability, catalogCollation, ensureReviewCatalog, isReview, periodLimits, taskName, validateBudgets, withClientBudgets } from './budgets.js';
import { listClientWork, projectWorkflowStatuses, saveWorkflowEntry, syncClientProjects } from './workflow-links.js';
import { clock, dateValue, shiftDate } from './dates.js';
import { leaveDates } from './leave.js';
import { deliverSubmission, postSlack, submissionText, slackConfigured } from './slack.js';
import { hubstaff, hubstaffConfigured } from './hubstaff.js';
import { defaultStatusReminder, parseStatusReminder, statusRemindersWithDelivery, statusScheduleRevision } from './settings.js';

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
const visibleProjects = (scope) => scope.projects.length ? {
  $or: [scoped(scope.visible), { workflowProjectId: { $in: scope.projects } }],
} : scoped(scope.visible);
const visibleEntry = (scope, entry) => includes(scope.visible, entry.clientId) || scope.dailyProjectIds.has(entry.projectId);
const reportMember = (member, date) => member.enrolled && (!member.reportFrom || member.reportFrom <= date);
const route = (handler, superOnly = false) => ah(async (req, res) => {
  if (superOnly) enforce(isSuper(req.user));
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body ??= {};
  const [models, scope] = await Promise.all([dailyModels(), dailyScope(req.user)]);
  scope.dailyProjectIds = new Set(scope.projects.length
    ? (await models.Project.distinct('_id', { workflowProjectId: { $in: scope.projects } })).map(String) : []);
  await handler(req, res, models, scope);
});

async function reminderSettings(models) {
  return { reminders: await statusRemindersWithDelivery(models), slackConfigured: slackConfigured() };
}

r.get('/settings/reminders', route(async (_req, res, models) => {
  res.json(await reminderSettings(models));
}, true));

r.post('/settings/reminders', route(async (req, res, models) => {
  const reminder = parseStatusReminder(req.body);
  await models.StatusReminder.create({ _id: String(new mongoose.Types.ObjectId()), ...reminder });
  res.status(201).json(await reminderSettings(models));
}, true));

r.put('/settings/reminders/:id', route(async (req, res, models) => {
  const isDefault = req.params.id === defaultStatusReminder._id;
  const _id = isDefault ? defaultStatusReminder._id : idValue(req.params.id);
  const reminder = parseStatusReminder(req.body);
  if (isDefault) reminder.scheduleRevision = statusScheduleRevision;
  const result = await models.StatusReminder.updateOne({ _id, deletedAt: null }, { $set: reminder }, { upsert: isDefault, runValidators: true });
  if (!result.matchedCount && !result.upsertedCount) throw new HttpError(404, 'Reminder not found');
  res.json(await reminderSettings(models));
}, true));

r.delete('/settings/reminders/:id', route(async (req, res, models) => {
  const isDefault = req.params.id === defaultStatusReminder._id;
  const _id = isDefault ? defaultStatusReminder._id : idValue(req.params.id);
  // Keep a record for the built-in reminder so the fallback cannot recreate it.
  const update = { $set: { deletedAt: new Date() } };
  if (isDefault) update.$setOnInsert = defaultStatusReminder;
  const result = await models.StatusReminder.updateOne({ _id }, update, { upsert: isDefault, runValidators: true });
  if (!result.matchedCount && !result.upsertedCount) throw new HttpError(404, 'Reminder not found');
  res.json(await reminderSettings(models));
}, true));

async function projectInScope(models, scope, id, managing = false, session) {
  const project = await models.Project.findById(idValue(id)).session(session || null);
  if (!project) throw new HttpError(404, 'Daily Work project not found');
  enforce(managing ? includes(scope.managed, project.clientId) :
    includes(scope.visible, project.clientId) || scope.projects.includes(project.workflowProjectId));
  return project;
}

function canSendToNewSlackChannel(doc) {
  return slackConfigured() && doc.entries.length > 0 && Boolean(doc.slackTs && doc.slackChannel) &&
    doc.slackChannel !== process.env.DAILY_WORK_SLACK_CHANNEL && ['sent', 'skipped'].includes(doc.delivery);
}

function publicSubmission(doc, entries = doc.entries) {
  return {
    id: doc._id, date: doc.date, memberId: doc.memberId, memberName: doc.memberName, entries,
    version: doc.__v, delivery: doc.delivery, slackPosted: Boolean(doc.slackTs),
    canSendToNewSlackChannel: canSendToNewSlackChannel(doc),
  };
}

r.get('/day/:date', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  const memberId = scope.own;
  const names = await syncClientProjects(models, scope.visible, scope.projects);
  const [projects, submission, assignments, settings] = await Promise.all([
    models.Project.find({ ...visibleProjects(scope), archived: false }).sort('name').lean(),
    models.Submission.findById(`${memberId}:${date}`).lean(),
    models.Assignment.find({ memberId }).lean(),
    models.Member.findById(memberId).lean(),
  ]);
  for (const project of projects) scope.dailyProjectIds.add(String(project._id));
  const [catalog, reviewAllowed, live] = await Promise.all([
    models.CatalogTask.find({ projectId: { $in: projects.map((project) => project._id) }, archived: false }).sort('title').lean(),
    canLogReview(req.user),
    projectWorkflowStatuses(submission ? [submission] : []),
  ]);
  const workItems = await listClientWork(projects, req.user, date, undefined, catalog);
  const budgetCatalog = withClientBudgets(catalog, workItems);
  res.json({
    date, projects: projects.map((project) => ({ ...project, clientName: names.get(project.clientId) })), workItems,
    catalog: await catalogAvailability(models, memberId, date, budgetCatalog.filter((task) => reviewAllowed || !isReview(task.title))),
    assignments: assignments.filter((entry) => scope.dailyProjectIds.has(entry.projectId)), memberName: req.user.name,
    reviewProjects: reviewAllowed ? projects.filter((project) => includes(scope.managed, project.clientId)).map((project) => String(project._id)) : [],
    submission: live[0] && publicSubmission(live[0], live[0].entries.filter((entry) => visibleEntry(scope, entry))),
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
  const sharedBudget = 'shared-project-budgets';
  await models.BudgetRevision.updateOne({ _id: sharedBudget }, { $setOnInsert: { revision: 0 } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });

  const submission = await models.Submission.db.transaction(async (session) => {
    // Serialize budget writes so simultaneous saves cannot spend the same project hours.
    await models.BudgetRevision.updateOne({ _id: sharedBudget }, { $inc: { revision: 1 } }, { session });
    return saveDay(req.user, models, scope, { date, key, entries, version, reviewAllowed, session });
  });
  const [live] = await projectWorkflowStatuses([submission.toObject()]);
  res.json(publicSubmission(live, live.entries.filter((entry) => visibleEntry(scope, entry))));
}));

r.post('/day/:date/slack', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  const key = `${scope.own}:${date}`;
  if (!slackConfigured()) throw new HttpError(503, 'Slack is not configured');
  const submission = await models.Submission.findById(key);
  if (!submission || (!submission.entries.length && !submission.slackTs)) fail('Save a task before sending to Slack');
  enforce(submission.entries.every((entry) => visibleEntry(scope, entry)));
  if (submission.delivery === 'uncertain') throw new HttpError(409, 'The last Slack delivery could not be confirmed.');
  if (submission.__v !== req.body.version) throw new HttpError(409, 'This submission changed. Reload it before sending.');
  const newChannel = canSendToNewSlackChannel(submission);
  if (submission.delivery === 'skipped' || newChannel) {
    const queued = await models.Submission.updateOne({ _id: key, __v: submission.__v, delivery: submission.delivery }, {
      $set: {
        delivery: 'pending', deliveryAfter: new Date(),
        ...(newChannel && { slackChannel: process.env.DAILY_WORK_SLACK_CHANNEL }),
      },
      ...(newChannel && { $unset: { slackTs: '' } }),
      $inc: { __v: 1 },
    });
    if (!queued.modifiedCount) throw new HttpError(409, 'This submission changed. Reload it before sending.');
  }
  const result = await deliverSubmission(models, key);
  const [live] = await projectWorkflowStatuses([result.toObject()]);
  res.json(publicSubmission(live, live.entries.filter((entry) => visibleEntry(scope, entry))));
}));

async function saveDay(user, models, scope, { date, key, entries, version, reviewAllowed, session }) {
  const previous = await models.Submission.findById(key).session(session);
  if ((previous && previous.__v !== version) || (!previous && version != null)) {
    throw new HttpError(409, 'This submission changed. Refresh before saving again.');
  }
  if (previous?.delivery === 'sending') {
    throw new HttpError(409, 'Slack delivery is in progress. Try again in a moment.');
  }
  if (!previous && !entries.length) fail('Add at least one task');
  const projectIds = [...new Set([...entries, ...(previous?.entries || [])].map((entry) => idValue(entry.projectId)))];
  const catalog = await models.CatalogTask.find({ projectId: { $in: projectIds } }).session(session).lean();
  const linkedProjects = await models.Project.find({ _id: { $in: projectIds }, ...visibleProjects(scope) }).session(session).lean();
  const removedProjects = new Set((await ClientProject.distinct('_id', {
    _id: { $in: linkedProjects.map((project) => project.workflowProjectId).filter(Boolean) }, deletedAt: { $ne: null },
  })).map(String));
  const workItems = await listClientWork(linkedProjects, user, undefined, session);
  const budgetCatalog = withClientBudgets(catalog, workItems);
  const saved = [];
  for (const input of entries) {
    const existing = input._id && previous?.entries.id(idValue(input._id));
    if (input._id && !existing) fail('A task has changed. Refresh before saving again.');
    if (existing && saved.some((row) => String(row._id) === input._id)) fail('Each task can only be included once');
    const sameProject = !!existing && existing.projectId === input.projectId;
    if (existing?.workflowTaskId && !sameProject) fail('Remove the entry and add another to change its project');
    const project = sameProject ? null : await projectInScope(models, scope, input.projectId, false, session);
    if (project?.archived || removedProjects.has(project?.workflowProjectId)) fail('Select an active project');
    const projectId = String(project?._id || existing.projectId);
    const clientId = project?.clientId || existing.clientId;
    if (!visibleEntry(scope, { clientId, projectId })) {
      if (existing && sameProject) { saved.push(existing.toObject()); continue; }
      enforce(false);
    }

    const enteredTitle = textValue(input.title, 230);
    const hours = hoursValue(input.hours);
    const { priority, status } = input;
    if (!['low', 'normal', 'high'].includes(priority) || !['incomplete', 'complete'].includes(status)) fail('Choose a valid status and priority');
    const projectCatalog = catalog.filter((item) => item.projectId === projectId);
    const namedTask = projectCatalog.find((item) => !item.archived && taskName(item.title) === taskName(enteredTitle));
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
    const projectWork = workItems.filter((item) => item.projectId === projectId);
    const master = projectWork.find((item) => item.id === (input.workItemId || existing?.workItemId)) ||
      projectWork.find((item) => taskName(item.title) === taskName(title));
    const customEdit = sameProject && !existing.catalogId && !existing.workItemId && !isReview(existing.title) &&
      !catalogTask && !master && !isReview(title);
    if (existing && hours > existing.hours && !customEdit) fail('Saved assigned task hours can only be reduced');
    if (!sameProject && !catalogTask && !master &&
      (projectWork.length || projectCatalog.some((item) => !item.archived && !isReview(item.title)))) {
      fail('Select a task from this project’s task list');
    }
    const description = master?.description || textValue(input.description ?? existing?.description, 3000, false);
    const row = {
      ...(existing && { _id: existing._id }),
      projectId, clientId, projectName: project?.name || existing.projectName,
      title, description, note: textValue(input.note ?? existing?.note, 500, false), hours, priority, status, catalogId: catalogTask && String(catalogTask._id),
    };
    const linkedProject = project || await projectInScope(models, scope, projectId, false, session);
    if (existing?.workflowTaskId && input.workflowTaskId && input.workflowTaskId !== existing.workflowTaskId) {
      fail('Remove the entry and add another to change its linked task');
    }
    await saveWorkflowEntry({ user, models, project: linkedProject, row, existing, input, date, session,
      managed: includes(scope.managed, clientId), period: catalogTask?.period });
    if (row.status === 'incomplete' && row.workflowStatus !== 'pending_review') row.incompleteReason = existing?.incompleteReason;
    saved.push(row);
  }
  // A full-day save cannot remove entries for a client whose access was revoked.
  for (const existing of previous?.entries || []) {
    if (!visibleEntry(scope, existing) && !saved.some((row) => String(row._id) === String(existing._id))) {
      saved.push(existing.toObject());
    }
  }
  const submission = previous || new models.Submission({ _id: key, memberId: scope.own, date });
  const initial = !previous;
  if (!initial && JSON.stringify(saved.map(comparableEntry)) === JSON.stringify(previous.entries.map(comparableEntry))) {
    return submission;
  }
  await validateBudgets(models, scope.own, date, budgetCatalog, saved, previous?.entries || [], session);
  submission.memberName = user.name;
  submission.entries = saved;
  markUnsent(submission);
  await submission.save({ session });
  return submission;
}

function comparableEntry(entry) {
  return ['_id', 'projectId', 'catalogId', 'workflowTaskId', 'workflowStatus', 'workItemId', 'title', 'description', 'note', 'incompleteReason', 'hours', 'priority', 'status'].map((field) => String(entry[field] ?? ''));
}

function markUnsent(submission) {
  if (submission.delivery !== 'uncertain') submission.delivery = 'skipped';
  submission.deliveryAfter = new Date();
  submission.deliveryAt = undefined;
}

function statusEntry(entry, own, scope) {
  const { workflowAssignedToMember, workflowCompletedByActor, ...row } = entry;
  const manager = includes(scope.managed, row.clientId);
  return { ...row, canUpdateStatus: workflowAssignedToMember !== false &&
    (manager || (own && (row.workflowStatus !== 'done' || workflowCompletedByActor))) };
}

r.patch('/day/:date/members/:memberId/entries/:id/status', route(async (req, res, models, scope) => {
  const date = dateValue(req.params.date);
  const memberId = idValue(req.params.memberId);
  const entryId = idValue(req.params.id);
  const own = scope.own === memberId;
  enforce(own || includes(scope.members, memberId));
  const { status, version } = req.body;
  if (!['incomplete', 'complete'].includes(status)) fail('Choose a valid status');
  const reason = status === 'incomplete' ? textValue(req.body.reason, 500) : undefined;

  const submission = await models.Submission.db.transaction(async (session) => {
    const doc = await models.Submission.findById(`${memberId}:${date}`).session(session);
    const entry = doc?.entries.id(entryId);
    if (!entry) throw new HttpError(404, 'Task entry not found');
    enforce(own ? visibleEntry(scope, entry) : includes(scope.managed, entry.clientId));
    if (doc.__v !== version) throw new HttpError(409, 'This task changed. Refresh before saving again.');
    if (doc.delivery === 'sending') throw new HttpError(409, 'Slack delivery is in progress. Try again in a moment.');

    let task;
    if (entry.workflowTaskId) {
      if (Task.db.getClient() !== models.Submission.db.getClient()) throw new HttpError(503, 'The linked Workflow task is unavailable');
      task = await Task.findOne({ _id: entry.workflowTaskId, client: entry.clientId, deletedAt: null }).session(session);
      if (task && !task.assignees.some((id) => String(id) === memberId)) {
        throw new HttpError(409, 'The linked Workflow task is no longer available');
      }
      // Keep the saved Daily Work entry editable when its linked occurrence was removed.
      if (!task) entry.workflowStatus = 'unavailable';
    }
    if (task) {
      applyTaskTransition(task, { status: status === 'complete' ? 'done' : 'in_progress' }, {
        manager: includes(scope.managed, entry.clientId), isAssignee: own, actorId: req.user._id,
      });
      if (task.isModified()) await task.save({ session });
      entry.workflowStatus = task.status;
      entry.status = task.status === 'done' ? 'complete' : 'incomplete';
    } else {
      entry.status = status;
    }
    entry.incompleteReason = reason;
    if (doc.isModified()) {
      markUnsent(doc);
      await doc.save({ session });
    }
    return doc;
  });
  const [live] = await projectWorkflowStatuses([submission.toObject()], req.user._id);
  const entry = live.entries.find((row) => String(row._id) === entryId);
  res.json({ entry: statusEntry(entry, own, scope), version: submission.__v });
}));

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
  const documents = await projectWorkflowStatuses(await models.Submission.find(filter).sort({ date: -1, memberName: 1 }).lean(), req.user._id);
  return documents.flatMap((doc) => {
    const own = doc.memberId === scope.own;
    const entries = doc.entries.filter((entry) => (own ? visibleEntry(scope, entry) : includes(scope.managed, entry.clientId)) &&
      (!req.query.projectId || entry.projectId === req.query.projectId) &&
      (!req.query.status || entry.status === req.query.status));
    return entries.length ? [publicSubmission(doc, entries.map((entry) => statusEntry(entry, own, scope)))] : [];
  });
}

r.get('/reports', route(async (req, res, models, scope) => {
  const [submissions, members, projects] = await Promise.all([
    reportRows(req, models, scope), roster(scope, models, true),
    models.Project.find(visibleProjects(scope)).sort('name').lean(),
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
    leaveDates(models.Leave, date),
  ]);
  const expected = members.filter((member) => reportMember(member, date) && !leave.has(`${member.id}:${date}`));
  res.json({ expected: expected.length, missing: expected.filter((member) => !submitted.includes(member.id))
    .map(({ id, name, shift, shiftStart }) => ({ id, name, shift, shiftStart })) });
}));

r.get('/manage', route(async (req, res, models, scope) => {
  const names = await syncClientProjects(models, scope.managed);
  const [workflow, projects, members, leave] = await Promise.all([
    workflowProjects(scope), models.Project.find(scoped(scope.managed)).sort('name').lean(), roster(scope, models),
    models.Leave.find({ period: { $ne: true }, date: { $gte: shiftDate(clock().date, -31) }, ...(scope.members !== null && { memberId: { $in: scope.members } }) }).sort('date').lean(),
  ]);
  const projectIds = projects.map((project) => project._id);
  const [catalog, assignments] = await Promise.all([
    models.CatalogTask.find({ projectId: { $in: projectIds } }).sort('title').lean(),
    models.Assignment.find({ projectId: { $in: projectIds }, ...(scope.members !== null && { memberId: { $in: scope.members } }) }).lean(),
  ]);
  res.json({ ...workflow, dailyProjects: projects.map((project) => ({ ...project, clientName: names.get(project.clientId) })),
    workItems: await listClientWork(projects, req.user), members, catalog, assignments, leave });
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
  if (req.body.archived === false && project.workflowProjectId) {
    await validateProjectLink(scope, project.clientId, project.workflowProjectId);
  }
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

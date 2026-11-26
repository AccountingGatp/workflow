import { Router } from 'express';
import mongoose from 'mongoose';
import { Task, TaskTemplate, AuditLog, User, ClientPermission, ClientProject, ProjectWorkItem } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';
import {
  audit, isSuper, canMonitorAllWork, canMaintainTasks, taskScope, staffTaskFilter, superAdminIds, canManageClient, canEditTaskInProject, taskPortfolio, portfolioFilter, managedClientIds, activePermissionFilter, ensureAssigneeAccess,
} from '../services/access.js';
import { generateRecurringTasks } from '../services/recurrence.js';
import { scheduleFields } from '../services/schedule.js';
import { applyTaskTransition } from '../services/task-review.js';

const r = Router();
const validateProject = async (clientId, projectId) => {
  const available = await ClientProject.exists({ client: clientId });
  if (!projectId) {
    if (available) throw new HttpError(400, 'Choose a project for this client');
    return undefined;
  }
  if (!mongoose.isValidObjectId(projectId) || !(await ClientProject.exists({ _id: projectId, client: clientId, deletedAt: null }))) {
    throw new HttpError(400, 'Project does not belong to this client');
  }
  return projectId;
};

const populateTask = (q) => q.populate('client', 'name').populate('team', 'name color')
  .populate('template', 'frequency').populate('project', 'name client').populate('masterItem', 'title links software notes automationStatus').populate({ path: 'assignees', select: 'name role', match: { role: { $ne: 'super_admin' } } }).populate({ path: 'owner', select: 'name', match: { role: { $ne: 'super_admin' } } }).populate('completedBy', 'name').select('-reviewer -submittedBy -submittedAt -reviewedBy -reviewedAt');

/**
 * Assignees must be able to see the client. If the person assigning is allowed to grant
 * access to them (their TL, or a Super Admin), access is granted automatically.
 */
async function assertAssignable(actor, clientId, userIds = [], projectId, existing = []) {
  for (const id of userIds) {
    const u = await User.findOne({ _id: id, deletedAt: null, active: true });
    if (!u) throw new HttpError(400, 'Unknown assignee');
    if (u.directAssignmentsPaused && !existing.some((assignee) => String(assignee) === String(u._id))) {
      throw new HttpError(400, `${u.name} is choosing tasks through Daily Work. Direct assignments are paused.`);
    }
    await ensureAssigneeAccess(actor, clientId, u, projectId);
  }
}



/* ---------- Tasks ---------- */

const dayBounds = () => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setHours(23, 59, 59, 999);
  const week = new Date(end); week.setDate(week.getDate() + 7);
  return { start, end, week };
};
const upcomingTemplateIds = async () => TaskTemplate.find({ frequency: { $in: ['weekly', 'monthly', 'semimonthly'] } }).distinct('_id');
const viewFilter = (view, dates, weeklyMonthly) => {
  const { start, end, week } = dates;
  const nextWeek = { dueDate: { $gt: end, $lte: week }, template: { $in: weeklyMonthly }, status: { $ne: 'done' } };
  if (view === 'today') return { dueDate: { $gte: start, $lte: end }, status: { $ne: 'done' } };
  if (view === 'overdue') return { dueDate: { $lt: start }, status: { $ne: 'done' } };
  if (view === 'upcoming') return nextWeek;
  if (view === 'due') return { dueDate: { $lte: end }, status: { $ne: 'done' } };
  if (view === 'pending' || view === 'active') return { $or: [{ dueDate: { $lte: end }, status: { $ne: 'done' } }, nextWeek] };
  if (view === 'completed') return { status: 'done' };
  if (view === 'done') return { status: 'done', completedAt: { $gte: new Date(Date.now() - 7 * 864e5) } };
  if (view === 'open') return { status: { $ne: 'done' } };
  return {};
};
const taskFilters = async (req, dates, weeklyMonthly, adminIds) => {
  const { scope = 'mine', status, client, project, team, assignee, from, to, view = 'all', q } = req.query;
  const clauses = [await taskScope(req.user), viewFilter(view, dates, weeklyMonthly), staffTaskFilter(adminIds)];
  if (scope === 'mine') {
    clauses.push({ assignees: isSuper(req.user) ? { $in: [] } : req.user._id });
  }
  if (req.user.directAssignmentsPaused && scope !== 'managed') {
    const ownDirect = scope === 'mine' ? { assignees: req.user._id } : { assignees: [req.user._id] };
    clauses.push({ $nor: [{ ...ownDirect, status: { $ne: 'done' },
      $or: [{ createdBy: { $ne: req.user._id } }, { template: { $ne: null } }],
    }] });
  }
  if (scope === 'managed') {
    if (req.user.role === 'employee') throw new HttpError(403, 'Managers only');
    clauses.push(portfolioFilter(await taskPortfolio(req.user)));
  }
  if (status) clauses.push({ status: { $in: String(status).split(',') } });
  if (client) {
    if (!mongoose.isValidObjectId(client)) throw new HttpError(400, 'Invalid client');
    clauses.push({ client });
  }
  if (project) {
    if (project === 'unassigned') clauses.push({ project: null });
    else {
      if (!mongoose.isValidObjectId(project)) throw new HttpError(400, 'Invalid project');
      clauses.push({ project });
    }
  }
  if (team) clauses.push({ team });
  if (assignee) {
    if (!mongoose.isValidObjectId(assignee)) throw new HttpError(400, 'Invalid assignee');
    clauses.push({ assignees: adminIds.some((id) => String(id) === String(assignee).toLowerCase()) ? { $in: [] } : assignee });
  }
  if (from || to) clauses.push({ dueDate: { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) } });
  if (q && String(q).trim()) clauses.push({ title: { $regex: String(q).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
  return { $and: clauses };
};

/* Lists are paginated in MongoDB; counts never depend on the number of tasks returned. */
export async function listTasks(user, query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize, 10) || 25));
  if (page > 100000) throw new HttpError(400, 'Page out of range');
  const dates = dayBounds();
  const [weeklyMonthly, adminIds] = await Promise.all([upcomingTemplateIds(), superAdminIds()]);
  const filter = await taskFilters({ user, query }, dates, weeklyMonthly, adminIds);
  const [total, items] = await Promise.all([
    Task.countDocuments(filter),
    populateTask(Task.find(filter).sort(['completed', 'done'].includes(query.view) ? { completedAt: -1, _id: -1 } : { dueDate: 1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize)).lean(),
  ]);
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

r.get('/tasks', ah(async (req, res) => res.json(await listTasks(req.user, req.query))));

r.get('/task-summary', ah(async (req, res) => {
  const dates = dayBounds();
  const [weeklyMonthly, adminIds] = await Promise.all([upcomingTemplateIds(), superAdminIds()]);
  const count = async (view) => Task.countDocuments(await taskFilters({ ...req, query: { ...req.query, view } }, dates, weeklyMonthly, adminIds));
  const [today, overdue, upcoming, done, pending] = await Promise.all(['today', 'overdue', 'upcoming', 'done', 'pending'].map(count));
  res.json({ today, overdue, upcoming, done, pending });
}));

/* Manager totals aggregate the entire managed portfolio, not a 500-task sample. */
r.get('/manager-workload', ah(async (req, res) => {
  if (req.user.role === 'employee') throw new HttpError(403, 'Managers only');
  const portfolio = await taskPortfolio(req.user);
  const clientId = req.query.client;
  const projectId = req.query.project;
  if (clientId && !mongoose.isValidObjectId(clientId)) throw new HttpError(400, 'Invalid client');
  if (projectId && projectId !== 'unassigned') {
    if (!mongoose.isValidObjectId(projectId)) throw new HttpError(400, 'Invalid project');
    const project = await ClientProject.findOne({ _id: projectId, deletedAt: null }).select('client');
    if (!project || (clientId && String(project.client) !== String(clientId)) || (!canMonitorAllWork(req.user) && !(await canEditTaskInProject(req.user, project.client, projectId)))) throw new HttpError(403, 'Project unavailable');
  }
  if (projectId === 'unassigned' && !clientId) throw new HttpError(400, 'Choose a client first');
  const selection = {
    ...(clientId && { client: new mongoose.Types.ObjectId(clientId) }),
    ...(projectId && { project: projectId === 'unassigned' ? null : new mongoose.Types.ObjectId(projectId) }),
  };
  const adminIds = await superAdminIds();
  const match = { $and: [portfolioFilter(portfolio), staffTaskFilter(adminIds)], ...selection, deletedAt: null };
  const { start, end, week } = dayBounds();
  const done = { $eq: ['$status', 'done'] };
  const pending = { $ne: ['$status', 'done'] };
  const dueToday = { $and: [pending, { $gte: ['$dueDate', start] }, { $lte: ['$dueDate', end] }] };
  const overdue = { $and: [pending, { $lt: ['$dueDate', start] }] };
  const future = { $and: [pending, { $gt: ['$dueDate', end] }] };
  const recentlyDone = { $and: [done, { $gte: ['$completedAt', new Date(Date.now() - 7 * 864e5)] }] };
  const values = {
    pending: pending, completed: done, overdue: overdue, today: dueToday,
    future: future, dueNow: { $and: [pending, { $lte: ['$dueDate', end] }] },
    completedRecent: recentlyDone,
  };
  const metrics = Object.fromEntries(Object.entries(values).map(([k, condition]) => [k, { $sum: { $cond: [condition, 1, 0] } }]));
  const [report] = await Task.aggregate([
    { $match: match },
    { $facet: {
      totals: [{ $group: { _id: null, ...metrics } }],
      people: [
        { $unwind: '$assignees' }, { $match: { assignees: { $nin: adminIds } } },
        { $group: { _id: '$assignees', ...metrics } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'person' } },
        { $project: { pending: 1, completed: 1, overdue: 1, today: 1, future: 1, dueNow: 1, completedRecent: 1,
          name: { $ifNull: [{ $first: '$person.name' }, 'Unknown employee'] } } },
        { $sort: { overdue: -1, today: -1, pending: -1 } },
      ],
      byProject: [
        { $group: { _id: '$project', ...metrics } },
        { $lookup: { from: 'clientprojects', localField: '_id', foreignField: '_id', as: 'project' } },
        { $project: { pending: 1, completed: 1, today: 1, overdue: 1, future: 1, dueNow: 1, completedRecent: 1,
          name: { $ifNull: [{ $first: '$project.name' }, 'Unassigned to project'] } } },
        { $sort: { name: 1 } },
      ],
    } },
  ]);
  const zero = { pending: 0, completed: 0, overdue: 0, today: 0, future: 0, dueNow: 0, completedRecent: 0 };
  const templatesFilter = { ...portfolioFilter(portfolio), ...selection };
  const masterFilter = { ...templatesFilter, active: { $ne: false } };
  const [masterItems, recurringSchedules, activeSchedules] = await Promise.all([
    ProjectWorkItem.countDocuments(masterFilter),
    TaskTemplate.countDocuments(templatesFilter),
    TaskTemplate.countDocuments({ ...templatesFilter, active: true }),
  ]);
  res.json({ totals: report.totals[0] || zero, people: report.people,
    byProject: report.byProject, masterItems, recurringSchedules, activeSchedules });
}));

const taskDetailFields = ['title', 'dueDate', 'priority', 'sop', 'owner', 'team', 'assignees', 'project'];
const taskActivity = [
  { action: 'task.create' },
  { action: 'task.update', summary: /(^|, )changed (title|dueDate|priority|sop|owner|team|assignees|project)(,|$)|^Edited “/ },
];

r.get('/tasks/:id', ah(async (req, res) => {
  const task = await populateTask(Task.findOne({ _id: req.params.id, ...(await taskScope(req.user)) })).populate('checklist.doneBy', 'name').lean();
  if (!task) throw new HttpError(404, 'Task not found');
  const activity = task.dailyWorkCustom ? [] : await AuditLog.find({ entity: 'Task', entityId: task._id, $or: taskActivity }).sort({ createdAt: -1 }).populate('actor', 'name').lean();
  const canEdit = await canEditTaskInProject(req.user, task.client._id, task.project?._id);
  const isAssignee = req.user.role !== 'hr' && task.assignees.some((person) => String(person._id) === String(req.user._id));
  res.json({ ...task, activity, canEdit, canChangeStatus: canEdit || (isAssignee &&
    (task.status !== 'done' || String(task.completedBy?._id) === String(req.user._id))),
    canChangeChecklist: canEdit || (task.status !== 'done' && isAssignee), canDelete: isSuper(req.user) });
}));

export async function createTask(user, body) {
  const { title, client, project, team, assignees = [], owner, dueDate, priority, sop, checklist = [] } = body || {};
  if (!title || !client || !dueDate) throw new HttpError(400, 'Title, client and due date are required');
  if (!(await canEditTaskInProject(user, client, project))) throw new HttpError(403, 'You can only create work for projects you manage');
  const validProject = await validateProject(client, project);
  await assertAssignable(user, client, assignees, validProject);
  const task = await Task.create({
    title, client, project: validProject, team: team || undefined, assignees, owner: owner || assignees[0], dueDate, priority, sop,
    checklist: checklist.filter(Boolean).map((text) => ({ text })), createdBy: user._id,
  });
  await audit(user, 'task.create', { entity: 'Task', entityId: task._id, client, project: task.project, summary: `Created “${title}”` });
  return task;
}

export async function updateTask(user, id, body) {
  const task = await Task.findOne({ _id: id, ...(await taskScope(user)) });
  if (!task) throw new HttpError(404, 'Task not found');
  body ??= {};
  const manager = await canEditTaskInProject(user, task.client, task.project);
  const isAssignee = task.assignees.some((a) => String(a) === String(user._id));
  if (!manager && !isAssignee) throw new HttpError(403, 'Only assignees or client managers can update this task');
  if (!manager && taskDetailFields.some((field) => body[field] !== undefined)) {
    throw new HttpError(403, 'You do not have permission to edit this task');
  }
  if (body.checklistItem && ['done', 'pending_review'].includes(body.status)) {
    throw new HttpError(400, 'Save checklist changes before completing the task');
  }
  if (!manager && task.status === 'done' && body.checklistItem) {
    throw new HttpError(400, 'Reopen the task before changing its checklist');
  }
  if (body.checklistItem) {
    const item = task.checklist.id(body.checklistItem.id);
    if (!item) throw new HttpError(404, 'Checklist item not found');
    item.done = !!body.checklistItem.done;
    item.doneBy = item.done ? user._id : undefined;
    item.doneAt = item.done ? new Date() : undefined;
  }
  if (manager) {
    if (body.project !== undefined) {
      const project = await validateProject(task.client, body.project);
      if (!await canEditTaskInProject(user, task.client, project)) throw new HttpError(403, 'You cannot move this task to that project');
      task.project = project;
    }
    for (const k of ['title', 'dueDate', 'priority', 'sop', 'owner', 'team']) {
      if (body[k] !== undefined) {
        if (k === 'dueDate' && task.template && !task.scheduledDate) task.scheduledDate = task.dueDate;
        task[k] = body[k] || undefined;
      }
    }
    if (task.isModified('project') && body.assignees === undefined) {
      await assertAssignable(user, task.client, task.assignees, task.project, task.assignees);
    }
    if (body.assignees !== undefined) {
      if (!Array.isArray(body.assignees) || body.assignees.some((id) => typeof id !== 'string' || !mongoose.isObjectIdOrHexString(id))) {
        throw new HttpError(400, 'Select valid assignees');
      }
      await assertAssignable(user, task.client, body.assignees, task.project, task.assignees);
      task.assignees = body.assignees;
      if (!body.assignees.some((a) => String(a) === String(task.owner))) task.owner = body.assignees[0];
    }
  }
  const edited = taskDetailFields.some((field) => task.isModified(field));
  const reopen = (task.status === 'done' || task.status === 'pending_review') &&
    (task.isModified('checklist') || ['title', 'dueDate', 'sop', 'assignees', 'project'].some((field) => task.isModified(field)));
  const status = body.status || (reopen ? 'in_progress' : undefined);
  if (status) applyTaskTransition(task, { status }, { manager, isAssignee, actorId: user._id });
  await task.save();
  if (edited && !task.dailyWorkCustom) await audit(user, 'task.update', { entity: 'Task', entityId: task._id, client: task.client, project: task.project, summary: `Edited “${task.title}”` });
  return task;
}

export async function deleteTask(user, id) {
  if (!isSuper(user)) throw new HttpError(403, 'Only Super Admins can delete tasks');
  const task = await Task.findOne({ _id: id, deletedAt: null });
  if (!task) throw new HttpError(404, 'Task not found');
  task.deletedAt = new Date(); task.status = 'cancelled';
  await task.save();
  if (!task.dailyWorkCustom) await audit(user, 'task.delete', { entity: 'Task', entityId: task._id, client: task.client, project: task.project, summary: `Deleted task occurrence “${task.title}”` });
  return { ok: true };
}

r.post('/tasks', ah(async (req, res) => res.status(201).json(await createTask(req.user, req.body))));
r.patch('/tasks/:id', ah(async (req, res) => res.json(await updateTask(req.user, req.params.id, req.body))));
r.delete('/tasks/:id', ah(async (req, res) => res.json(await deleteTask(req.user, req.params.id))));

/* ---------- Recurring templates ---------- */

export async function listRecurringTasks(user, { client, project, assignee, page = 1, pageSize = 25 } = {}) {
  const adminIds = assignee ? await superAdminIds() : [];
  const filter = { $and: [portfolioFilter(await taskPortfolio(user)), {
    ...(client && { client }), ...(project && { project }), ...(assignee && { assignees: adminIds.some((id) => String(id) === String(assignee).toLowerCase()) ? { $in: [] } : assignee }),
  }] };
  const [total, items] = await Promise.all([
    TaskTemplate.countDocuments(filter),
    TaskTemplate.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize)
      .populate('client', 'name').populate('project', 'name client').populate('masterItem', 'title automationStatus').populate({ path: 'assignees', select: 'name role', match: { role: { $ne: 'super_admin' } } }).select('-reviewer').lean(),
  ]);
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

// Assignment-only changes intentionally leave master definitions and materialized occurrences intact.
export async function updateRecurringAssignments(user, templateId, assignees, mode) {
  const tpl = await TaskTemplate.findById(templateId);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (user.role === 'hr' || !(await canEditTaskInProject(user, tpl.client, tpl.project))) {
    throw new HttpError(403, 'You do not have permission to edit this recurring task');
  }
  const before = tpl.assignees.map(String);
  const requested = [...new Set(assignees.map(a => String(a).toLowerCase()))];
  const after = mode === 'add' ? [...new Set([...before, ...requested])] :
    mode === 'remove' ? before.filter(a => !requested.includes(a)) : requested;
  if (after.length > 25) throw new HttpError(400, 'Maximum 25 assignees');
  await assertAssignable(user, tpl.client, after.filter(a => !before.includes(a)), tpl.project);
  if (before.length === after.length && before.every((a, i) => a === after[i])) {
    return { template: tpl, changed: false, existingOccurrencesUnchanged: true };
  }
  const owner = after.includes(String(tpl.owner)) ? String(tpl.owner) : after[0];
  const result = await TaskTemplate.updateOne({ _id: tpl._id, assignees: before, owner: tpl.owner ?? null }, {
    $set: { assignees: after, ...(owner && { owner }) },
    ...(!owner && { $unset: { owner: 1 } }),
  });
  if (!result.matchedCount) throw new HttpError(409, 'Assignments changed; read the template again before retrying');
  await audit(user, 'template.edit', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, project: tpl.project,
    summary: `Changed recurring assignments for “${tpl.title}” (${before.length} to ${after.length})` });
  return { template: await TaskTemplate.findById(tpl._id), changed: true, existingOccurrencesUnchanged: true };
}


r.get('/templates', ah(async (req, res) => {
  const portfolio = await taskPortfolio(req.user);
  const { clients: managed } = portfolio;
  const filter = portfolioFilter(portfolio);
  const templates = await TaskTemplate.find(filter).sort({ createdAt: -1 })
    .populate('client', 'name').populate('project', 'name client').populate('team', 'name color').populate({ path: 'assignees', select: 'name role', match: { role: { $ne: 'super_admin' } } }).select('-reviewer').lean();
  res.json(templates.map((template) => ({ ...template, canEdit: req.user.role !== 'hr', canDelete: canMaintainTasks(req.user) && (managed === null || managed.includes(String(template.client?._id))) })));
}));

export async function createRecurringTask(user, body) {
  const b = body || {};
  if (!b.title || !b.client || !b.frequency) throw new HttpError(400, 'Title, client and frequency are required');
  if (!(await canEditTaskInProject(user, b.client, b.project))) throw new HttpError(403, 'You can only schedule work for projects you manage');
  const validProject = await validateProject(b.client, b.project);
  const schedule = scheduleFields(b);
  const assignees = b.assignees || [];
  await assertAssignable(user, b.client, assignees, validProject);
  const fields = {
    title: String(b.title).trim(), client: b.client, project: validProject, team: b.team || undefined,
    assignees, owner: assignees.includes(b.owner) ? b.owner : assignees[0],
    priority: b.priority, sop: b.sop, checklist: (b.checklist || []).filter(Boolean), createdBy: user._id, ...schedule,
  };
  const { template, created } = await TaskTemplate.db.transaction(async (session) => {
    const [template] = await TaskTemplate.create([{ ...fields, masterItem: b.masterItem }], { session });
    if (b.masterItem) {
      if (!validProject) throw new HttpError(400, 'Select the project that owns the master task');
      // Touch the master row in the transaction to serialize competing links.
      const master = await ProjectWorkItem.findOneAndUpdate({
        _id: b.masterItem, project: validProject, client: b.client, active: { $ne: false },
      }, { $set: { scheduledTemplate: template._id } }, { session });
      if (!master) throw new HttpError(404, 'Active master task not found in the selected project');
      const existing = await TaskTemplate.exists({ _id: { $ne: template._id }, $or: [
        { masterItem: master._id },
        ...(master.scheduledTemplate ? [{ _id: master.scheduledTemplate }] : []),
      ] }).session(session);
      if (existing) throw new HttpError(409, 'This master task already has a recurring schedule');
    }
    return { template, created: await generateRecurringTasks(template._id, session) };
  });
  await audit(user, 'template.create', { entity: 'TaskTemplate', entityId: template._id, client: b.client, project: template.project, summary: `Scheduled ${b.frequency} “${template.title}” (${created} upcoming tasks)` });
  return { template, created };
}

r.post('/templates', ah(async (req, res) => res.status(201).json(await createRecurringTask(req.user, req.body))));

r.patch('/templates/:id', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (!(await canEditTaskInProject(req.user, tpl.client, tpl.project))) throw new HttpError(403, 'You do not have permission to edit this recurring task');
  if (req.body.active === true && tpl.project) await validateProject(tpl.client, tpl.project);
  if (typeof req.body.active === 'boolean') tpl.active = req.body.active;
  await tpl.save();
  if (tpl.active) await generateRecurringTasks(tpl._id);
  audit(req.user, 'template.update', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, project: tpl.project, summary: `${tpl.active ? 'Resumed' : 'Paused'} “${tpl.title}”` });
  res.json(tpl);
}));

/* Managers may maintain a template, but may not change its client. */
r.patch('/templates/:id/details', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (!(await canEditTaskInProject(req.user, tpl.client, tpl.project))) throw new HttpError(403, 'You do not have permission to edit this recurring task');
  const b = req.body || {};
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Task name is required');
  const schedule = scheduleFields(b);
  const assignees = Array.isArray(b.assignees) ? b.assignees : [];
  const validProject = await validateProject(tpl.client, b.project ?? tpl.project);
  if (!await canEditTaskInProject(req.user, tpl.client, validProject)) throw new HttpError(403, 'You cannot move this schedule to that project');
  await assertAssignable(req.user, tpl.client, assignees, validProject, tpl.assignees);
  tpl.project = validProject;
  tpl.title = String(b.title).trim();
  Object.assign(tpl, schedule);
  tpl.priority = b.priority || 'normal';
  tpl.sop = String(b.sop || '');
  tpl.checklist = (Array.isArray(b.checklist) ? b.checklist : []).map(x => String(x).trim()).filter(Boolean);
  tpl.assignees = assignees;
  tpl.owner = assignees.includes(b.owner) ? b.owner : assignees[0];
  await tpl.save();
  // Change upcoming, untouched occurrences to the new schedule while preserving all
  // completed, in-progress, waiting, overdue and partially checked tasks.
  const now = new Date();
  const cleared = await Task.deleteMany({
    template: tpl._id, dueDate: { $gt: now }, status: 'todo',
    'checklist.done': { $ne: true },
  });
  const created = tpl.active ? await generateRecurringTasks(tpl._id) : 0;
  await audit(req.user, 'template.edit', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, project: tpl.project, summary: `Edited recurring task “${tpl.title}”: ${cleared.deletedCount} future untouched occurrences replaced, ${created} scheduled` });
  res.json({ template: tpl, cleared: cleared.deletedCount, created });
}));

r.delete('/templates/:id', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (!canMaintainTasks(req.user) || !(await canManageClient(req.user, tpl.client))) throw new HttpError(403, 'Only client managers and Super Admins can delete recurring tasks');
  // Cancel only future untouched occurrences. Never erase finished work or
  // tasks that someone has already started or partially checked off.
  const cancelled = await Task.deleteMany({
    template: tpl._id, dueDate: { $gt: new Date() }, status: 'todo',
    'checklist.done': { $ne: true },
  });
  await tpl.deleteOne();
  audit(req.user, 'template.delete', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client,
    summary: `Deleted recurring schedule “${tpl.title}”; cancelled ${cancelled.deletedCount} future untouched occurrences, retained active/history` });
  res.json({ ok: true, cancelled: cancelled.deletedCount });
}));

/* ---------- Dashboard / workload ---------- */

r.get('/dashboard', ah(async (req, res) => {
  const now = new Date();
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const eod = new Date(now); eod.setHours(23, 59, 59, 999);
  const [access, adminIds] = await Promise.all([taskScope(req.user), superAdminIds()]);
  const scope = { $and: [access, staffTaskFilter(adminIds)] };
  const mine = { $and: [scope, { assignees: isSuper(req.user) ? { $in: [] } : req.user._id }], status: { $ne: 'done' } };
  const [dueToday, overdue, upcoming] = await Promise.all([
    Task.countDocuments({ ...mine, dueDate: { $gte: sod, $lte: eod } }),
    Task.countDocuments({ ...mine, dueDate: { $lt: sod } }),
    Task.countDocuments({ ...mine, dueDate: { $gt: eod } }),
  ]);
  const result = { mine: { dueToday, overdue, upcoming } };

  if (req.user.role !== 'employee') {
    // Workload across everything this user manages
    const open = { ...scope, status: { $ne: 'done' } };
    const byPerson = await Task.aggregate([
      { $match: open }, { $unwind: '$assignees' }, { $match: { assignees: { $nin: adminIds } } },
      { $group: {
        _id: '$assignees',
        open: { $sum: 1 },
        overdue: { $sum: { $cond: [{ $lt: ['$dueDate', sod] }, 1, 0] } },
        today: { $sum: { $cond: [{ $and: [{ $gte: ['$dueDate', sod] }, { $lte: ['$dueDate', eod] }] }, 1, 0] } },
      } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { open: 1, overdue: 1, today: 1, name: { $first: '$u.name' } } },
      { $sort: { overdue: -1, open: -1 } },
    ]);
    const byStatus = await Task.aggregate([{ $match: { ...scope, dueDate: { $lte: new Date(eod.getTime() + 7 * 864e5) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const byClient = await Task.aggregate([
      { $match: open },
      { $group: { _id: '$client', open: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ['$dueDate', sod] }, 1, 0] } } } },
      { $lookup: { from: 'clients', localField: '_id', foreignField: '_id', as: 'c' } },
      { $project: { open: 1, overdue: 1, name: { $first: '$c.name' } } },
      { $sort: { open: -1 } },
    ]);
    const expiringSoon = await ClientPermission.find({
      ...activePermissionFilter(), expiresAt: { $ne: null, $lte: new Date(now.getTime() + 7 * 864e5) },
      ...(isSuper(req.user) ? {} : { client: { $in: await managedClientIds(req.user) } }),
    }).populate('user', 'name').populate('client', 'name').lean();
    Object.assign(result, { byPerson, byStatus, byClient, expiringSoon });
  }
  res.json(result);
}));

r.get('/audit', ah(async (req, res) => {
  if (req.user.role === 'employee') throw new HttpError(403, 'Not available');
  const changes = { $or: [...taskActivity, { action: { $in: ['project.work.create', 'project.work.update', 'template.create', 'template.edit'] } }] };
  const pipeline = [
    { $match: changes },
    { $lookup: {
      from: Task.collection.name, localField: 'entityId', foreignField: '_id',
      let: { entity: '$entity' },
      pipeline: [{ $match: { $expr: { $eq: ['$$entity', 'Task'] } } }, { $project: { dailyWorkCustom: 1, project: 1 } }],
      as: 'Task',
    } },
    { $match: { 'Task.dailyWorkCustom': { $ne: true } } },
  ];
  if (req.user.role === 'manager') {
    const portfolio = await taskPortfolio(req.user);
    const scope = portfolioFilter(portfolio);
    // Older entries predate the project field. Look up their project from the recorded work item.
    for (const [model, entity] of [[TaskTemplate, 'TaskTemplate'], [ProjectWorkItem, 'ProjectWorkItem']]) {
      pipeline.push({ $lookup: {
        from: model.collection.name, localField: 'entityId', foreignField: '_id',
        let: { entity: '$entity', loggedProject: '$project' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$$entity', entity] }, { $eq: [{ $ifNull: ['$$loggedProject', null] }, null] }] } } }, { $project: { project: 1 } }],
        as: entity,
      } });
    }
    pipeline.push({ $set: { project: { $ifNull: ['$project', { $first: '$Task.project' }, { $first: '$TaskTemplate.project' }, { $first: '$ProjectWorkItem.project' }] } } },
      { $match: { $or: [...scope.$or, { actor: req.user._id }] } },
      { $unset: ['TaskTemplate', 'ProjectWorkItem'] });
  }
  pipeline.push({ $sort: { createdAt: -1 } }, { $limit: 200 }, { $unset: 'Task' });
  const activity = await AuditLog.aggregate(pipeline);
  res.json(await AuditLog.populate(activity, [
    { path: 'actor', select: 'name role' }, { path: 'client', select: 'name' }, { path: 'project', select: 'name' },
  ]));
}));

export default r;

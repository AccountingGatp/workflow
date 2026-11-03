import { Router } from 'express';
import mongoose from 'mongoose';
import { Task, TaskTemplate, AuditLog, User, ClientPermission, Client } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';
import {
  audit, isSuper, taskScope, canManageClient, canSeeClient, managedClientIds, activePermissionFilter, canGrantDirectly,
} from '../services/access.js';
import { generateRecurringTasks } from '../services/recurrence.js';

const r = Router();
const populateTask = (q) => q.populate('client', 'name').populate('team', 'name color')
  .populate('template', 'frequency').populate('assignees', 'name').populate('owner', 'name').populate('completedBy', 'name');

/**
 * Assignees must be able to see the client. If the person assigning is allowed to grant
 * access to them (their TL, or a Super Admin), access is granted automatically.
 */
async function assertAssignable(actor, clientId, userIds = []) {
  for (const id of userIds) {
    const u = await User.findOne({ _id: id, deletedAt: null, active: true });
    if (!u) throw new HttpError(400, 'Unknown assignee');
    if (await canSeeClient(u, clientId)) continue;
    if (!(await canGrantDirectly(actor, clientId, u._id))) {
      throw new HttpError(400, `${u.name} is not in your team and has no access to this client. Ask a Super Admin to grant access first.`);
    }
    const perm = await ClientPermission.create({ client: clientId, user: u._id, grantedBy: actor._id });
    const client = await Client.findById(clientId).select('name');
    audit(actor, 'access.grant', { entity: 'ClientPermission', entityId: perm._id, client: clientId, summary: `Gave ${u.name} access to ${client?.name} (assigned work)` });
  }
}

/* ---------- Tasks ---------- */

const dayBounds = () => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setHours(23, 59, 59, 999);
  const week = new Date(end); week.setDate(week.getDate() + 7);
  return { start, end, week };
};
const upcomingTemplateIds = async () => TaskTemplate.find({ frequency: { $in: ['weekly', 'monthly'] } }).distinct('_id');
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
const taskFilters = async (req, dates, weeklyMonthly) => {
  const { scope = 'mine', status, client, team, assignee, from, to, view = 'all', q } = req.query;
  const clauses = [await taskScope(req.user), viewFilter(view, dates, weeklyMonthly)];
  if (scope === 'mine') clauses.push({ assignees: req.user._id });
  if (status) clauses.push({ status: { $in: String(status).split(',') } });
  if (client) {
    if (!mongoose.isValidObjectId(client)) throw new HttpError(400, 'Invalid client');
    clauses.push({ client });
  }
  if (team) clauses.push({ team });
  if (assignee) {
    if (!mongoose.isValidObjectId(assignee)) throw new HttpError(400, 'Invalid assignee');
    clauses.push({ assignees: assignee });
  }
  if (from || to) clauses.push({ dueDate: { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) } });
  if (q && String(q).trim()) clauses.push({ title: { $regex: String(q).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
  return { $and: clauses };
};

/* Lists are paginated in MongoDB; counts never depend on the number of tasks returned. */
r.get('/tasks', ah(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));
  if (page > 100000) throw new HttpError(400, 'Page out of range');
  const dates = dayBounds();
  const weeklyMonthly = await upcomingTemplateIds();
  const filter = await taskFilters(req, dates, weeklyMonthly);
  const [total, items] = await Promise.all([
    Task.countDocuments(filter),
    populateTask(Task.find(filter).sort({ dueDate: 1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize)).lean(),
  ]);
  res.json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}));

r.get('/task-summary', ah(async (req, res) => {
  const dates = dayBounds();
  const weeklyMonthly = await upcomingTemplateIds();
  const count = async (view) => Task.countDocuments(await taskFilters({ ...req, query: { ...req.query, view } }, dates, weeklyMonthly));
  const [today, overdue, upcoming, done, pending] = await Promise.all(['today', 'overdue', 'upcoming', 'done', 'pending'].map(count));
  res.json({ today, overdue, upcoming, done, pending });
}));

/* Manager totals aggregate the entire managed portfolio, not a 500-task sample. */
r.get('/manager-workload', ah(async (req, res) => {
  if (req.user.role === 'employee') throw new HttpError(403, 'Managers only');
  const managed = await managedClientIds(req.user);
  const clientId = req.query.client;
  if (clientId && (!mongoose.isValidObjectId(clientId) || !(await canManageClient(req.user, clientId)))) throw new HttpError(403, 'Client unavailable');
  const ids = clientId ? [clientId] : managed;
  const match = ids === null ? {} : { client: { $in: ids.map(id => new mongoose.Types.ObjectId(String(id))) } };
  const { start, end } = dayBounds();
  const [report] = await Task.aggregate([
    { $match: match },
    { $facet: {
      totals: [{ $group: {
        _id: null, pending: { $sum: { $cond: [{ $ne: ['$status', 'done'] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'done'] }, { $lt: ['$dueDate', start] }] }, 1, 0] } },
        today: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'done'] }, { $gte: ['$dueDate', start] }, { $lte: ['$dueDate', end] }] }, 1, 0] } },
      } }],
      people: [
        { $unwind: '$assignees' }, { $group: {
          _id: '$assignees',
          pending: { $sum: { $cond: [{ $ne: ['$status', 'done'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'done'] }, { $lt: ['$dueDate', start] }] }, 1, 0] } },
          today: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'done'] }, { $gte: ['$dueDate', start] }, { $lte: ['$dueDate', end] }] }, 1, 0] } },
        } }, { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'person' } },
        { $project: { pending: 1, completed: 1, overdue: 1, today: 1, name: { $first: '$person.name' } } },
        { $sort: { overdue: -1, pending: -1 } }
      ],
    } },
  ]);
  res.json({ totals: report.totals[0] || { pending: 0, completed: 0, overdue: 0, today: 0 }, people: report.people });
}));

r.get('/tasks/:id', ah(async (req, res) => {
  const task = await populateTask(Task.findOne({ _id: req.params.id, ...(await taskScope(req.user)) })).populate('checklist.doneBy', 'name').lean();
  if (!task) throw new HttpError(404, 'Task not found');
  const activity = await AuditLog.find({ entity: 'Task', entityId: task._id }).sort({ createdAt: -1 }).populate('actor', 'name').lean();
  res.json({ ...task, activity, canEdit: await canManageClient(req.user, task.client._id) });
}));

r.post('/tasks', ah(async (req, res) => {
  const { title, client, team, assignees = [], owner, dueDate, priority, sop, checklist = [] } = req.body || {};
  if (!title || !client || !dueDate) throw new HttpError(400, 'Title, client and due date are required');
  if (!(await canManageClient(req.user, client))) throw new HttpError(403, 'You can only create work for clients you manage');
  await assertAssignable(req.user, client, assignees);
  const task = await Task.create({
    title, client, team: team || undefined, assignees, owner: owner || assignees[0], dueDate, priority, sop,
    checklist: checklist.filter(Boolean).map((text) => ({ text })), createdBy: req.user._id,
  });
  audit(req.user, 'task.create', { entity: 'Task', entityId: task._id, client, summary: `Created “${title}”` });
  res.status(201).json(task);
}));

r.patch('/tasks/:id', ah(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, ...(await taskScope(req.user)) });
  if (!task) throw new HttpError(404, 'Task not found');
  const manager = await canManageClient(req.user, task.client);
  const isAssignee = task.assignees.some((a) => String(a) === String(req.user._id));
  if (!manager && !isAssignee) throw new HttpError(403, 'Only assignees or managing admins can update this task');
  const body = req.body || {};
  const notes = [];

  if (body.status && body.status !== task.status) {
    notes.push(`status ${task.status} → ${body.status}`);
    task.status = body.status;
    task.completedAt = body.status === 'done' ? new Date() : undefined;
    task.completedBy = body.status === 'done' ? req.user._id : undefined;
  }
  if (body.checklistItem) {
    const item = task.checklist.id(body.checklistItem.id);
    if (!item) throw new HttpError(404, 'Checklist item not found');
    item.done = !!body.checklistItem.done;
    item.doneBy = item.done ? req.user._id : undefined;
    item.doneAt = item.done ? new Date() : undefined;
    notes.push(`${item.done ? 'ticked' : 'unticked'} “${item.text}”`);
  }
  if (manager) {
    for (const k of ['title', 'dueDate', 'priority', 'sop', 'owner', 'team']) {
      if (body[k] !== undefined) { task[k] = body[k] || undefined; notes.push(`changed ${k}`); }
    }
    if (body.assignees) {
      await assertAssignable(req.user, task.client, body.assignees);
      task.assignees = body.assignees; notes.push('changed assignees');
      if (!body.assignees.some((a) => String(a) === String(task.owner))) task.owner = body.assignees[0];
    }
  }
  await task.save();
  if (notes.length) audit(req.user, 'task.update', { entity: 'Task', entityId: task._id, client: task.client, summary: notes.join(', ') });
  res.json(task);
}));

/* ---------- Recurring templates ---------- */

r.get('/templates', ah(async (req, res) => {
  const managed = await managedClientIds(req.user);
  const filter = managed === null ? {} : { client: { $in: managed } };
  res.json(await TaskTemplate.find(filter).sort({ createdAt: -1 })
    .populate('client', 'name').populate('team', 'name color').populate('assignees', 'name').lean());
}));

r.post('/templates', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.client || !b.frequency) throw new HttpError(400, 'Title, client and frequency are required');
  if (!(await canManageClient(req.user, b.client))) throw new HttpError(403, 'You can only schedule work for clients you manage');
  await assertAssignable(req.user, b.client, b.assignees || []);
  const tpl = await TaskTemplate.create({ ...b, team: b.team || undefined, checklist: (b.checklist || []).filter(Boolean), createdBy: req.user._id });
  const created = await generateRecurringTasks(tpl._id);
  audit(req.user, 'template.create', { entity: 'TaskTemplate', entityId: tpl._id, client: b.client, summary: `Scheduled ${b.frequency} “${b.title}” (${created} upcoming tasks)` });
  res.status(201).json({ template: tpl, created });
}));

r.patch('/templates/:id', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl || !(await canManageClient(req.user, tpl.client))) throw new HttpError(404, 'Template not found');
  if (typeof req.body.active === 'boolean') tpl.active = req.body.active;
  await tpl.save();
  if (tpl.active) await generateRecurringTasks(tpl._id);
  audit(req.user, 'template.update', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, summary: `${tpl.active ? 'Resumed' : 'Paused'} “${tpl.title}”` });
  res.json(tpl);
}));

/* Managers may maintain a template, but may not change its client. */
r.patch('/templates/:id/details', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (!(await canManageClient(req.user, tpl.client))) throw new HttpError(403, 'Only client managers and Super Admins can edit recurring tasks');
  const b = req.body || {};
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Task name is required');
  if (!['daily', 'weekly', 'monthly'].includes(b.frequency)) throw new HttpError(400, 'Invalid frequency');
  const assignees = Array.isArray(b.assignees) ? b.assignees : [];
  await assertAssignable(req.user, tpl.client, assignees);
  tpl.title = String(b.title).trim();
  tpl.frequency = b.frequency;
  tpl.weekday = b.frequency === 'weekly' ? Number(b.weekday ?? 1) : undefined;
  tpl.monthDay = b.frequency === 'monthly' ? Number(b.monthDay ?? 1) : undefined;
  tpl.priority = b.priority || 'normal';
  tpl.sop = String(b.sop || '');
  tpl.checklist = (Array.isArray(b.checklist) ? b.checklist : []).map(x => String(x).trim()).filter(Boolean);
  tpl.assignees = assignees;
  tpl.owner = assignees.includes(b.owner) ? b.owner : assignees[0];
  await tpl.save();
  // Existing occurrences are retained as historical tasks; new ones use revised values.
  await generateRecurringTasks(tpl._id);
  audit(req.user, 'template.edit', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, summary: `Edited recurring task “${tpl.title}”` });
  res.json(tpl);
}));

r.delete('/templates/:id', ah(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw new HttpError(404, 'Template not found');
  if (!(await canManageClient(req.user, tpl.client))) throw new HttpError(403, 'Only client managers and Super Admins can delete recurring tasks');
  // Stop future occurrences while keeping already generated tasks and their audit history.
  await tpl.deleteOne();
  audit(req.user, 'template.delete', { entity: 'TaskTemplate', entityId: tpl._id, client: tpl.client, summary: `Deleted recurring schedule “${tpl.title}”; existing tasks retained` });
  res.json({ ok: true });
}));

/* ---------- Dashboard / workload ---------- */

r.get('/dashboard', ah(async (req, res) => {
  const now = new Date();
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const eod = new Date(now); eod.setHours(23, 59, 59, 999);
  const scope = await taskScope(req.user);
  const mine = { ...scope, assignees: req.user._id, status: { $ne: 'done' } };
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
      { $match: open }, { $unwind: '$assignees' },
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
  const managed = await managedClientIds(req.user);
  const filter = managed === null ? {} : { $or: [{ client: { $in: managed } }, { actor: req.user._id }] };
  res.json(await AuditLog.find(filter).sort({ createdAt: -1 }).limit(200).populate('actor', 'name role').populate('client', 'name').lean());
}));

export default r;

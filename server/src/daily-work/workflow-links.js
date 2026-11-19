import { Types } from 'mongoose';
import { Client, ClientProject, ProjectWorkItem, Task, TaskTemplate, User } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { canSeeClient } from '../services/access.js';
import { applyTaskTransition } from '../services/task-review.js';
import { catalogCollation, ensureReviewCatalog, isReview, taskName } from './budgets.js';

export async function syncClientProjects(models, clientIds) {
  const clients = await Client.find({ ...(clientIds === null ? {} : { _id: { $in: clientIds } }), status: { $ne: 'inactive' } })
    .select('name').lean();
  const ids = clients.map(({ _id }) => String(_id));
  const [workspaces, saved] = await Promise.all([
    ClientProject.find({ client: { $in: ids } }).select('client name').lean(),
    models.Project.find({ clientId: { $in: ids } }).lean(),
  ]);
  const sources = workspaces.map(({ _id, client, name }) => ({ name, clientId: String(client), workflowProjectId: String(_id) }));
  const scopedClients = new Set(sources.map((row) => row.clientId));
  sources.push(...clients.filter(({ _id }) => !scopedClients.has(String(_id)))
    .map(({ _id, name }) => ({ name, clientId: String(_id) })));

  const additions = sources.flatMap((source) => {
    const matches = saved.filter((row) => row.clientId === source.clientId);
    if (matches.some((row) => row.workflowProjectId === source.workflowProjectId &&
      (source.workflowProjectId || taskName(row.name) === taskName(source.name)))) return [];
    const sameName = matches.find((row) => taskName(row.name) === taskName(source.name));
    if (sameName && !sameName.workflowProjectId && source.workflowProjectId) return [{
      updateOne: { filter: { _id: sameName._id, workflowProjectId: null }, update: { $set: { workflowProjectId: source.workflowProjectId } } },
    }];
    if (sameName) return [];
    return [{ updateOne: {
      filter: { clientId: source.clientId, name: source.name }, collation: catalogCollation,
      update: { $setOnInsert: source }, upsert: true,
    } }];
  });
  if (additions.length) {
    await models.Project.db.transaction(async (session) => {
      const result = await models.Project.bulkWrite(additions, { session });
      await ensureReviewCatalog(models, Object.values(result.upsertedIds).map((_id) => ({ _id })), session);
    });
  }
  const clientNames = new Map(clients.map(({ _id, name }) => [String(_id), name]));
  return clientNames;
}

function estimatedHours(value) {
  const parsed = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)?(?:\s+(?:daily|weekly|monthly))?$/i);
  if (!parsed) return undefined;
  const hours = Number(parsed[1]) / (/^m/i.test(parsed[2] || '') ? 60 : 1);
  return hours <= 24 ? Math.round(hours * 100) / 100 : undefined;
}

export async function listClientWork(projects, user) {
  const ids = projects.map((project) => project.workflowProjectId).filter(Boolean);
  const items = await ProjectWorkItem.find({ project: { $in: ids }, active: { $ne: false } })
    .select('project client title responsible responsibleUser weeklyHours frequency').sort('title').lean();
  const projectFor = new Map(projects.filter((row) => row.workflowProjectId).map((row) => [row.workflowProjectId, String(row._id)]));
  return items.filter((item) => !isReview(item.title)).map((item) => ({
    id: String(item._id), projectId: projectFor.get(String(item.project)), title: item.title,
    responsible: item.responsible, frequency: item.frequency, hours: estimatedHours(item.weeklyHours),
    canLog: !item.responsibleUser || String(item.responsibleUser) === String(user._id),
  }));
}

function readableSource(task, row) {
  return task && String(task.client) === String(row.clientId);
}

export async function projectWorkflowStatuses(submissions) {
  const ids = [...new Set(submissions.flatMap((doc) => doc.entries.map((row) => row.workflowTaskId).filter(Boolean)))];
  if (!ids.length) return submissions;
  const tasks = await Task.find({ _id: { $in: ids }, deletedAt: null }).select('client title status checklist').lean();
  const states = new Map(tasks.map((task) => [String(task._id), task]));
  return submissions.map((doc) => ({ ...doc, entries: doc.entries.map((row) => {
    if (!row.workflowTaskId) return row;
    const task = states.get(row.workflowTaskId);
    if (!readableSource(task, row)) return { ...row, workflowStatus: 'unavailable' };
    return { ...row, title: task.title, checklist: task.checklist, workflowStatus: task.status, status: task.status === 'done' ? 'complete' : 'incomplete' };
  }) }));
}

export async function saveWorkflowEntry({ user, models, project, row, existing, input, date, session, managed }) {
  const taskId = input.workflowTaskId || existing?.workflowTaskId;
  let masterId = input.workItemId || existing?.workItemId;
  if (isReview(row.title)) return;
  if (Task.db.getClient() !== models.Submission.db.getClient()) {
    if (taskId || masterId) throw new HttpError(503, 'Linked tasks require Daily Work and Clients on the same MongoDB cluster');
    return;
  }

  const memberId = String(user._id);
  const filter = { client: row.clientId, assignees: memberId, deletedAt: null, status: { $ne: 'cancelled' } };
  const projectId = project.workflowProjectId;
  if (projectId) filter.project = projectId;
  const dayEnd = new Date(`${date}T18:30:00.000Z`);
  const dayStart = new Date(dayEnd.getTime() - 86400000);
  if (!taskId && !masterId && projectId) {
    const matches = await ProjectWorkItem.find({ project: projectId, client: row.clientId, title: row.title, active: { $ne: false } })
      .collation(catalogCollation).select('_id').limit(2).session(session).lean();
    if (matches.length > 1) throw new HttpError(400, 'Select the matching task from the client’s list');
    masterId = matches[0] && String(matches[0]._id);
  }
  let task;
  let master;
  if (masterId) {
    if (!Types.ObjectId.isValid(masterId) || !projectId) throw new HttpError(400, 'Choose a task from this project');
    master = await ProjectWorkItem.findOne({ _id: masterId, project: projectId, client: row.clientId }).session(session).lean();
    if (!master || (master.active === false && !taskId)) throw new HttpError(404, 'This task is no longer in the client’s list');
    if (master.responsibleUser && String(master.responsibleUser) !== memberId && !taskId) {
      throw new HttpError(403, 'This client task is assigned to another employee');
    }
  }
  if (taskId) {
    if (!Types.ObjectId.isValid(taskId)) throw new HttpError(400, 'Choose a valid Workflow task');
    if (master) filter.$or = [{ masterItem: master._id }, ...(master.scheduledTemplate ? [{ template: master.scheduledTemplate }] : [])];
    const due = taskId === existing?.workflowTaskId ? {} : { dueDate: { $lt: dayEnd } };
    task = await Task.findOne({ ...filter, ...due, _id: taskId }).session(session);
    if (!task) {
      if (taskId === existing?.workflowTaskId) {
        row.workflowTaskId = taskId;
        row.workItemId = existing.workItemId;
        row.workflowStatus = 'unavailable';
        row.status = existing.status;
        return;
      }
      throw new HttpError(404, 'This Workflow task is no longer available to you');
    }
  } else if (master) {
    const [scheduled] = await TaskTemplate.find({ $or: [{ masterItem: master._id }, ...(master.scheduledTemplate ? [{ _id: master.scheduledTemplate }] : [])], active: true })
      .select('_id').limit(1).session(session).lean();
    const occurrence = scheduled
      ? { dueDate: { $lt: dayEnd }, $and: [
        { $or: [{ masterItem: master._id }, { template: scheduled._id }] },
        { $or: [{ status: { $ne: 'done' } }, { dueDate: { $gte: dayStart } }] },
      ] }
      : { masterItem: master._id, dueDate: { $gte: dayStart, $lt: dayEnd } };
    task = await Task.findOne({ ...filter, ...occurrence }).sort({ dueDate: -1 }).session(session);
    if (!task && scheduled) throw new HttpError(400, 'No occurrence of this scheduled client task is available for this date');
  } else if (!existing) {
    const sameDay = { ...filter, project: projectId || null, title: row.title, dueDate: { $gte: dayStart, $lt: dayEnd } };
    task = await Task.findOne(sameDay).collation(catalogCollation).session(session);
  }
  if (!task) {
    const lead = user.role === 'employee' && user.reviewLead
      ? await User.findOne({ _id: user.reviewLead, active: true, role: 'admin', deletedAt: null }).session(session).lean()
      : null;
    task = new Task({
      client: row.clientId, project: projectId, masterItem: master?._id,
      title: master?.title || row.title, dueDate: new Date(`${date}T12:00:00+05:30`),
      assignees: [user._id], owner: user._id, createdBy: user._id, reviewer: lead && await canSeeClient(lead, row.clientId) ? lead._id : undefined,
      priority: row.priority, status: 'in_progress',
    });
  }

  if (input.checklistChanges !== undefined) {
    if (!Array.isArray(input.checklistChanges) || input.checklistChanges.length > task.checklist.length) {
      throw new HttpError(400, 'Check the task’s checklist and try again');
    }
    for (const change of input.checklistChanges) {
      const step = task.checklist.id(change?.id);
      if (!step || typeof change.done !== 'boolean') throw new HttpError(400, 'This checklist step is no longer available');
      if (step.done === change.done) continue;
      if (['done', 'pending_review'].includes(task.status)) throw new HttpError(409, 'This task is already complete or in review. Refresh before editing.');
      step.done = change.done;
      step.doneAt = change.done ? new Date() : undefined;
      step.doneBy = change.done ? user._id : undefined;
    }
  }
  if (row.status === 'complete' && !['done', 'pending_review'].includes(task.status)) {
    applyTaskTransition(task, { status: 'done' }, { manager: managed, isAssignee: true, actorId: user._id, actorRole: user.role });
  }
  if (task.isNew || task.isModified()) await task.save({ session });
  row.title = task.title;
  row.workflowTaskId = String(task._id);
  row.workflowStatus = task.status;
  row.workItemId = masterId || (task.masterItem && String(task.masterItem));
  row.status = task.status === 'done' ? 'complete' : 'incomplete';
}

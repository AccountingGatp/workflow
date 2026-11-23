import { Types } from 'mongoose';
import { Client, ClientProject, ProjectWorkItem, Task, TaskTemplate, AuditLog } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { matches, materializeOccurrence } from '../services/recurrence.js';
import { clock, shiftDate } from './dates.js';
import { applyTaskTransition } from '../services/task-review.js';
import { catalogCollation, ensureReviewCatalog, isReview, periodBounds, periodLimits, taskName } from './budgets.js';

export async function syncClientProjects(models, clientIds, projectIds = []) {
  const clientFilter = clientIds === null ? {} : { _id: { $in: clientIds } };
  if (projectIds.length) {
    const extraClients = await ClientProject.distinct('client', { _id: { $in: projectIds } });
    clientFilter._id = { $in: [...clientIds, ...extraClients] };
  }
  const clients = await Client.find({ ...clientFilter, status: { $ne: 'inactive' } }).select('name').lean();
  const ids = clients.map(({ _id }) => String(_id));
  const [workspaces, saved] = await Promise.all([
    ClientProject.find({ client: { $in: ids }, ...(clientIds === null ? {} : {
      $or: [{ client: { $in: clientIds } }, { _id: { $in: projectIds } }],
    }) }).select('client name deletedAt').lean(),
    models.Project.find({ clientId: { $in: ids } }).lean(),
  ]);
  const removed = workspaces.filter((workspace) => workspace.deletedAt).map(({ _id }) => String(_id));
  if (removed.length) await models.Project.updateMany({
    workflowProjectId: { $in: removed }, archived: false,
  }, { $set: { archived: true } });
  const sources = workspaces.filter((workspace) => !workspace.deletedAt)
    .map(({ _id, client, name }) => ({ name, clientId: String(client), workflowProjectId: String(_id) }));
  const scopedClients = new Set(workspaces.map((workspace) => String(workspace.client)));
  sources.push(...clients.filter(({ _id }) => !scopedClients.has(String(_id)) && (clientIds === null || clientIds.includes(String(_id))))
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

function settingsFor(item) {
  const raw = item.weeklyHours?.trim() || '';
  const parsed = raw.match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)?(?:\s+(daily|weekly|monthly))?$/i);
  const frequency = item.frequency?.trim().toLowerCase() || '';
  const period = parsed?.[3]?.toLowerCase() || frequency.match(/^(daily|weekly|monthly)\b/)?.[1];
  if (!parsed) return { period };
  const hours = Number(parsed[1]) / (/^m/i.test(parsed[2] || '') ? 60 : 1);
  return { period, hours: hours <= (periodLimits[period] || 24) ? Math.round(hours * 100) / 100 : undefined };
}

const dayStartFor = (date) => new Date(`${date}T00:00:00+05:30`);
const periodRange = (date, period) => {
  const [start, end] = periodBounds(date, period || 'daily');
  return { $gte: dayStartFor(start), $lt: dayStartFor(shiftDate(end, 1)) };
};
const occurrenceMatches = (task, range, memberId) =>
  task.dueDate >= range.$gte && task.dueDate < range.$lt && task.assignees.some((id) => String(id) === memberId);
const taskDetail = (task) => task && ({
  id: String(task._id), priority: task.priority, checklist: task.checklist, status: task.status,
});

const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function masterScheduledOn(item, day) {
  const frequency = (item.frequency || '').toLowerCase();
  const schedule = `${frequency} ${item.executionDay || ''}`.toLowerCase();
  if (/^(monthly|biweekly|semi.?monthly)\b/.test(frequency)) {
    const monthDays = [...schedule.matchAll(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g)].map((match) => Number(match[1]));
    if (/\b(?:month[- ]end|last day)\b/.test(schedule)) monthDays.push(31);
    return matches({ frequency: 'semimonthly', monthDays }, day);
  }
  const listed = [...schedule.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b/g)]
    .map((match) => weekdays.indexOf(match[1]));
  return listed.length ? listed.includes(day.getDay()) :
    /^daily\b/.test(frequency) && matches({ frequency: 'daily' }, day);
}

export async function listClientWork(projects, user, date, session, catalog = []) {
  const ids = projects.map((project) => project.workflowProjectId).filter(Boolean);
  const items = await ProjectWorkItem.find({ project: { $in: ids }, active: { $ne: false } })
    .select('project client title responsible responsibleUser weeklyHours frequency notes executionDay scheduledTemplate').sort('title').session(session || null).lean();
  const templates = items.length ? await TaskTemplate.find({ active: true, $or: [
    { masterItem: { $in: items.map((item) => item._id) } },
    { _id: { $in: items.map((item) => item.scheduledTemplate).filter(Boolean) } },
  ] }).select('masterItem frequency assignees weekday weekdays monthDay monthDays startsOn').session(session || null).lean() : [];
  const memberId = String(user._id);
  const calendarDay = date && new Date(`${date}T12:00:00`);
  const periodDates = date ? Object.keys(periodLimits).map((period) => periodRange(date, period)) : [];
  const tasks = date && items.length ? await Task.find({
    project: { $in: ids }, assignees: user._id, deletedAt: null, status: { $ne: 'cancelled' },
    dueDate: { $gte: new Date(Math.min(...periodDates.map((range) => +range.$gte))), $lt: new Date(Math.max(...periodDates.map((range) => +range.$lt))) },
    $or: [{ masterItem: { $in: items.map((item) => item._id) } },
      { template: { $in: items.map((item) => item.scheduledTemplate).filter(Boolean) } }],
  }).select('assignees dueDate scheduledDate masterItem template status checklist priority').sort({ dueDate: 1 }).lean() : [];
  const projectFor = new Map(projects.filter((row) => row.workflowProjectId).map((row) => [row.workflowProjectId, String(row._id)]));
  return items.filter((item) => !isReview(item.title)).map((item) => {
    const settings = settingsFor(item);
    const projectId = projectFor.get(String(item.project));
    const template = templates.find((entry) => String(entry.masterItem) === String(item._id) ||
      String(entry._id) === String(item.scheduledTemplate));
    const override = catalog.find((entry) => entry.projectId === projectId && taskName(entry.title) === taskName(item.title));
    const templatePeriod = template?.frequency === 'semimonthly' ? 'monthly' : template?.frequency;
    const period = override?.period || settings.period || templatePeriod || (settings.hours != null ? 'daily' : undefined);
    const range = date && periodRange(date, period);
    const occurrences = tasks.filter((task) => String(task.masterItem) === String(item._id) ||
      (template && String(task.template) === String(template._id)));
    const dueToday = date && occurrences.find((task) => clock(task.dueDate).date === date);
    const task = dueToday || (date && occurrences.find((task) => occurrenceMatches(task, range, memberId)));
    const assigned = item.responsibleUser ? String(item.responsibleUser) === memberId :
      Boolean(item.responsible && taskName(item.responsible) === taskName(user.name));
    const suggested = date && (dueToday
      ? !['done', 'pending_review'].includes(dueToday.status)
      : template
        ? template.assignees.some((id) => String(id) === memberId) &&
          (!template.startsOn || clock(template.startsOn).date <= date) && matches(template, calendarDay) &&
          !occurrences.some((item) => item.scheduledDate && clock(item.scheduledDate).date === date)
        : !item.scheduledTemplate && assigned && masterScheduledOn(item, calendarDay) && !['done', 'pending_review'].includes(task?.status));
    return {
      id: String(item._id), projectId, title: item.title,
      description: item.notes, responsible: item.responsible, frequency: item.frequency, ...settings, period,
      occurrence: taskDetail(task), occurrenceDueToday: Boolean(dueToday), suggested: Boolean(suggested), canLog: !item.responsibleUser || String(item.responsibleUser) === String(user._id) || !!task,
    };
  });
}

async function findMasterOccurrence(master, filter, date, overridePeriod, session, memberId) {
  const template = await TaskTemplate.findOne({
    $or: [{ masterItem: master._id }, ...(master.scheduledTemplate ? [{ _id: master.scheduledTemplate }] : [])],
    active: true,
  }).session(session);
  const period = overridePeriod || settingsFor(master).period || (template?.frequency === 'semimonthly' ? 'monthly' : template?.frequency) || 'daily';
  const range = periodRange(date, period);
  const occurrence = { ...filter, dueDate: range,
    $or: [{ masterItem: master._id }, ...(template ? [{ template: template._id }] : [])] };
  if (template?.frequency === 'semimonthly' && template.assignees.some((id) => String(id) === memberId)) {
    const due = new Date(`${date}T17:00:00`);
    if (clock(template.startsOn).date <= date && matches(template, due)) {
      await materializeOccurrence(template, due, session);
      const exact = await Task.findOne({ ...filter, template: template._id,
        $or: [{ scheduledDate: due }, { dueDate: periodRange(date, 'daily') }] }).session(session);
      if (exact) return exact;
    }
  }
  const found = await Task.findOne(occurrence).sort({ dueDate: 1 }).session(session);
  if (found || !template) return found;
  if (!template.assignees.some((id) => String(id) === memberId)) {
    throw new HttpError(403, 'This client task is assigned to another employee');
  }
  const [from, to] = periodBounds(date, period);
  for (let day = from; day <= to; day = shiftDate(day, 1)) {
    // Use the recurring scheduler's local-day rules and its regular 17:00 due time.
    const due = new Date(`${day}T17:00:00`);
    const starts = new Date(template.startsOn);
    starts.setHours(0, 0, 0, 0);
    if (due < starts || !matches(template, due)) continue;
    await materializeOccurrence(template, due, session);
    const task = await Task.findOne({ ...filter, template: template._id, $or: [{ scheduledDate: due }, { dueDate: due }] }).session(session);
    if (task) return task;
  }
  return null;
}

function readableSource(task, row) {
  return task && String(task.client) === String(row.clientId);
}

export async function projectWorkflowStatuses(submissions, actorId) {
  const ids = [...new Set(submissions.flatMap((doc) => doc.entries.map((row) => row.workflowTaskId).filter(Boolean)))];
  if (!ids.length) return submissions;
  const fields = actorId ? 'client title status checklist assignees completedBy' : 'client title status checklist';
  const tasks = await Task.find({ _id: { $in: ids }, deletedAt: null }).select(fields).lean();
  const states = new Map(tasks.map((task) => [String(task._id), task]));
  return submissions.map((doc) => ({ ...doc, entries: doc.entries.map((row) => {
    if (!row.workflowTaskId) return row;
    const task = states.get(row.workflowTaskId);
    if (!readableSource(task, row)) return { ...row, workflowStatus: 'unavailable' };
    return { ...row, title: task.title, checklist: task.checklist, workflowStatus: task.status,
      status: task.status === 'done' ? 'complete' : 'incomplete',
      incompleteReason: task.status === 'done' ? undefined : row.incompleteReason,
      ...(actorId && {
        workflowAssignedToMember: task.assignees?.some((assignee) => String(assignee) === doc.memberId) ?? false,
        workflowCompletedByActor: String(task.completedBy) === String(actorId),
      }),
    };
  }) }));
}

export async function saveWorkflowEntry({ user, models, project, row, existing, input, date, session, managed, period }) {
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
    task = await findMasterOccurrence(master, filter, date, period, session, memberId);
  } else if (!existing) {
    const sameDay = { ...filter, project: projectId || null, title: row.title, dueDate: { $gte: dayStart, $lt: dayEnd } };
    task = await Task.findOne(sameDay).collation(catalogCollation).session(session);
  }
  if (!task) {
    if (master?.responsibleUser && String(master.responsibleUser) !== memberId) {
      throw new HttpError(403, 'This client task is assigned to another employee');
    }
    task = new Task({
      client: row.clientId, project: projectId, masterItem: master?._id,
      dailyWorkCustom: !master && !row.catalogId,
      title: master?.title || row.title, dueDate: new Date(`${date}T12:00:00+05:30`),
      assignees: [user._id], owner: user._id, createdBy: user._id,
      priority: row.priority, sop: row.description || undefined, status: 'in_progress',
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
      if (task.status === 'done') throw new HttpError(409, 'This task is already complete. Refresh before editing.');
      step.done = change.done;
      step.doneAt = change.done ? new Date() : undefined;
      step.doneBy = change.done ? user._id : undefined;
    }
  }
  if (row.status === 'complete' && task.status !== 'done') {
    applyTaskTransition(task, { status: 'done' }, { manager: managed, isAssignee: true, actorId: user._id });
  }
  const created = task.isNew;
  if (created || task.isModified()) await task.save({ session });
  if (created && !task.dailyWorkCustom) await AuditLog.create([{
    actor: user._id, action: 'task.create', entity: 'Task', entityId: task._id, client: task.client,
    summary: `Created “${task.title}”`,
  }], { session });
  row.title = task.title;
  row.workflowTaskId = String(task._id);
  row.workflowStatus = task.status;
  row.workItemId = masterId || (task.masterItem && String(task.masterItem));
  row.status = task.status === 'done' ? 'complete' : 'incomplete';
}

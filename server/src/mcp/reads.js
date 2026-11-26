import { ProjectWorkItem, User } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { visibleProjectDirectory } from '../routes/projects.js';
import { superAdminIds } from '../services/access.js';
import { loadEntryAutomation, automationCode, clientSpecificTaskTitle, entryAutomationCode } from '../services/task-automation.js';
import { dailyModels } from '../daily-work/models.js';
import { clock, dateValue, shiftDate } from '../daily-work/dates.js';
import { leaveOverlap } from '../daily-work/leave.js';
import { listDailySubmissions } from '../daily-work/routes.js';

export function withTaskAutomation(result) {
  return {
    ...result,
    items: result.items.map(({ masterItem, ...item }) => {
      if (!masterItem) return { ...item, masterItem, automationCode: automationCode(item) };
      const { automationStatus, ...master } = masterItem;
      const code = automationCode({ ...master, automationStatus });
      return { ...item, masterItem: { ...master, automationCode: code }, automationCode: code };
    }),
  };
}

export async function listMasterTasks(user, { client, project, automation, page = 1, pageSize = 25 }) {
  const directory = await visibleProjectDirectory(user);
  const projects = directory.projects.filter((row) => (!client || String(row.client) === client.toLowerCase()) &&
    (!project || String(row._id) === project.toLowerCase()));
  const byProject = new Map(projects.map((row) => [String(row._id), row.name]));
  const filter = { project: { $in: projects.map(({ _id }) => _id) }, active: { $ne: false } };
  if (automation === 'A') filter.automationStatus = true;
  if (automation && automation !== 'A') {
    filter.automationStatus = { $ne: true };
    filter.title = automation === 'N/A' ? clientSpecificTaskTitle : { $not: clientSpecificTaskTitle };
  }
  const [items, total, adminIds] = await Promise.all([
    ProjectWorkItem.find(filter).select('-sourceKey -__v -automated').sort({ project: 1, title: 1, _id: 1 })
      .skip((page - 1) * pageSize).limit(pageSize).lean(),
    ProjectWorkItem.countDocuments(filter),
    superAdminIds(),
  ]);
  const admins = new Set(adminIds.map(String));
  return { items: items.map(({ automationStatus, ...item }) => ({
    ...item,
    ...(admins.has(String(item.responsibleUser)) && { responsible: undefined, responsibleUser: undefined }),
    projectName: byProject.get(String(item.project)),
    clientName: directory.clientInfo.get(String(item.client))?.standaloneProject ? undefined :
      directory.clientInfo.get(String(item.client))?.name,
    automationCode: automationCode({ ...item, automationStatus }),
  })), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function listLeave(user, { from, to, memberId, page = 1, pageSize = 25 }) {
  if (user.role !== 'super_admin') throw new HttpError(403, 'Only Super Admins can read employee leave through MCP');
  const start = dateValue(from || to || clock().date);
  const end = dateValue(to || start);
  if (end < start || end > shiftDate(start, 365)) throw new HttpError(400, 'Select an inclusive leave date range of up to 366 days');
  const { Leave } = await dailyModels();
  const filter = {
    $and: [leaveOverlap(start, end), { $or: [
      { period: { $ne: true } }, { through: null }, { $expr: { $gte: ['$through', '$date'] } },
    ] }],
    ...(memberId && { memberId: memberId.toLowerCase() }),
  };
  const [records, total] = await Promise.all([
    Leave.find(filter).select('memberId date through period').sort({ date: -1, memberId: 1, _id: 1 })
      .skip((page - 1) * pageSize).limit(pageSize).lean(),
    Leave.countDocuments(filter),
  ]);
  const memberIds = [...new Set(records.map((row) => row.memberId))].filter((id) => /^[0-9a-f]{24}$/i.test(id));
  const people = memberIds.length ? await User.find({ _id: { $in: memberIds } }).select('name').lean() : [];
  const names = new Map(people.map((person) => [String(person._id), person.name]));
  return { from: start, to: end, items: records.map((row) => ({
    id: row._id, memberId: row.memberId, memberName: names.get(row.memberId) || null,
    from: row.date, through: row.period ? row.through || null : row.date,
  })), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function listDailyWork(user, { date, from, to, memberId, projectId, status, page = 1, pageSize = 10 }) {
  if (date && (from || to)) throw new HttpError(400, 'Select a single date or a date range');
  if (to && !from) throw new HttpError(400, 'Choose a start date for the range');
  const start = date || from || clock().date;
  const rows = await listDailySubmissions(user, { from: start, to: to || start, memberId, projectId, status });
  const selected = rows.slice((page - 1) * pageSize, page * pageSize);
  const workItems = await loadEntryAutomation(selected);
  return { submissions: selected.map((row) => ({
    ...row, entries: row.entries.map((entry) => ({ ...entry, automationCode: entryAutomationCode(entry, workItems) })),
  })), page, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) };
}

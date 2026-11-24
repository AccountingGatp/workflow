import { ClientProject, Task, TaskTemplate } from '../models/index.js';

const LOOKAHEAD_DAYS = 14;

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export function matches(tpl, day) {
  if (tpl.frequency === 'daily') return day.getDay() !== 0 && day.getDay() !== 6; // working days
  if (tpl.frequency === 'weekly') return Array.isArray(tpl.weekdays) && tpl.weekdays.length > 0 ? tpl.weekdays.includes(day.getDay()) : day.getDay() === (tpl.weekday ?? 1);
  const lastDay = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
  if (tpl.frequency === 'monthly') return day.getDate() === Math.min(tpl.monthDay ?? 1, lastDay);
  if (tpl.frequency === 'semimonthly') return (tpl.monthDays || []).some(d => day.getDate() === Math.min(d, lastDay));
  return false;
}

export function materializeOccurrence(tpl, due, session) {
  return Task.updateOne(
    { template: tpl._id, $or: [{ dueDate: due }, { scheduledDate: due }] },
    { $setOnInsert: {
      scheduledDate: due, dueDate: due, template: tpl._id, title: tpl.title, client: tpl.client, project: tpl.project, masterItem: tpl.masterItem, team: tpl.team, assignees: tpl.assignees,
      owner: tpl.owner || tpl.assignees[0], priority: tpl.priority, sop: tpl.sop,
      checklist: tpl.checklist.map((text) => ({ text })), createdBy: tpl.createdBy,
    } },
    { upsert: true, session },
  );
}

/**
 * Materialise tasks from active templates for today .. today+LOOKAHEAD.
 * Each occurrence is created independently of whether the previous one was finished,
 * so overdue work stays visible. Idempotent via unique (template, dueDate).
 */
export async function generateRecurringTasks(templateId, session) {
  const filter = { active: true };
  if (templateId) filter._id = templateId;
  const templates = await TaskTemplate.find(filter).session(session || null);
  const projectIds = templates.map((template) => template.project).filter(Boolean);
  const removedProjects = new Set((await ClientProject.distinct('_id', {
    _id: { $in: projectIds }, deletedAt: { $ne: null },
  }).session(session || null)).map(String));
  const today = startOfDay(new Date());
  let created = 0;
  for (const tpl of templates) {
    if (removedProjects.has(String(tpl.project))) continue;
    const from = startOfDay(tpl.startsOn > today ? tpl.startsOn : today);
    for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
      const day = new Date(from); day.setDate(from.getDate() + i);
      if (!matches(tpl, day)) continue;
      const due = new Date(day); due.setHours(17, 0, 0, 0);
      const res = await materializeOccurrence(tpl, due, session);
      created += res.upsertedCount || 0;
    }
  }
  return created;
}

export function startScheduler() {
  generateRecurringTasks().catch(console.error);
  setInterval(() => generateRecurringTasks().catch(console.error), 60 * 60 * 1000);
}

import mongoose from 'mongoose';
import { User, Task, TaskTemplate, ProjectWorkItem, ClientPermission } from './models/index.js';
import { canSeeClient } from './services/access.js';

const ID = 'bluntd-loan-sathya-krupali-2026-11-13-v2';
const IMPORT = 'bluntd-loan-reminders-2026-11-13-v1';
export async function assignLoanReviewers() {
  const migrations = mongoose.connection.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id: ID, state: 'completed' })) return { alreadyApplied: true };
  const [sathya, krupali, actor, templates] = await Promise.all([
    User.findOne({ email: 'sathya.p@gatpsolutions.com', active: true, deletedAt: null }),
    User.findOne({ email: 'krupali.s@gatpsolutions.com', active: true, deletedAt: null }),
    User.findOne({ role: 'super_admin', active: true, deletedAt: null }),
    TaskTemplate.find({ importKey: { $in: ['mercedes', 'insurance', 'ford', 'td'].map(k => `${IMPORT}-${k}`) } }),
  ]);
  if (!sathya || !krupali || !actor || !templates.length) return { skipped: 'Existing loan reminders or employee/reviewer account unavailable' };
  const clients = [...new Set(templates.map(t => String(t.client)))];
  for (const client of clients) for (const person of [sathya, krupali]) {
    if (!(await canSeeClient(person, client))) await ClientPermission.updateOne({ client, user: person._id, revokedAt: null, expiresAt: null }, { $setOnInsert: { level: 'work', grantedBy: actor._id } }, { upsert: true });
  }
  const ids = templates.map(t => t._id);
  const assignment = { assignees: [sathya._id], owner: sathya._id, reviewer: krupali._id };
  // Apply to current open occurrences and schedules; keep completed work and cancellations intact.
  await TaskTemplate.updateMany({ _id: { $in: ids } }, { $set: assignment });
  const tasks = await Task.updateMany({ template: { $in: ids }, deletedAt: null, status: { $nin: ['done', 'cancelled'] } }, { $set: assignment });
  for (const tpl of templates) {
    const sop = `${(tpl.sop || '').replace(' Assignee pending manager confirmation.', '').replace(/\nAssigned employee:.*?Reviewer:.*?\.$/, '')}\nAssigned employee: ${sathya.name}. Reviewer: ${krupali.name}.`;
    await TaskTemplate.updateOne({ _id: tpl._id }, { $set: { sop } });
    await Task.updateMany({ template: tpl._id, deletedAt: null, status: { $nin: ['done', 'cancelled'] } }, { $set: { sop } });
    if (tpl.masterItem) await ProjectWorkItem.updateOne({ _id: tpl.masterItem }, { $set: { responsibleUser: sathya._id, responsible: sathya.name, notes: sop } });
  }
  await migrations.updateOne({ _id: ID }, { $set: { state: 'completed', completedAt: new Date() } }, { upsert: true });
  return { schedulesUpdated: templates.length, openTasksUpdated: tasks.modifiedCount, employee: sathya.name, reviewer: krupali.name };
}

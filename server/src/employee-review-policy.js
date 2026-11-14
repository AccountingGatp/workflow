import mongoose from 'mongoose';
import { User, Task, TaskTemplate, ClientPermission } from './models/index.js';
import { canSeeClient } from './services/access.js';

const ID = 'employee-review-sathya-krupali-2026-11-14-v1';
export async function applyEmployeeReviewPolicy() {
  const migrations = mongoose.connection.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id: ID })) return { alreadyApplied: true };
  const sathya = await User.findOne({ email: 'sathya.p@gatpsolutions.com', active: true, deletedAt: null });
  const krupali = await User.findOne({ email: 'krupali.s@gatpsolutions.com', active: true, deletedAt: null });
  const actor = await User.findOne({ role: 'super_admin', active: true, deletedAt: null });
  if (!sathya || !krupali || !actor) return { skipped: 'Existing employee or team leader unavailable' };
  if (krupali.role !== 'admin') return { skipped: 'Krupali must have the existing Admin / TL role to review employee work' };
  await User.updateOne({ _id: sathya._id }, { $set: { reviewLead: krupali._id } });
  const open = { deletedAt: null, status: { $nin: ['done', 'cancelled'] } };
  const clients = [...new Set([
    ...await Task.distinct('client', { ...open, assignees: sathya._id }),
    ...await TaskTemplate.distinct('client', { assignees: sathya._id }),
  ].map(String))];
  for (const client of clients) {
    if (!(await canSeeClient(krupali, client))) await ClientPermission.updateOne({ client, user: krupali._id, revokedAt: null, expiresAt: null }, { $setOnInsert: { level: 'work', grantedBy: actor._id } }, { upsert: true });
  }
  const employeeTasks = await Task.updateMany({ ...open, assignees: sathya._id }, { $set: { reviewer: krupali._id } });
  const employeeSchedules = await TaskTemplate.updateMany({ assignees: sathya._id }, { $set: { reviewer: krupali._id } });
  // Krupali's own work has no reviewer; preserve completed history and any shared employee work.
  const own = { assignees: { $size: 1, $all: [krupali._id] } };
  const ownTasks = await Task.updateMany({ ...open, ...own }, { $unset: { reviewer: '' } });
  const ownSchedules = await TaskTemplate.updateMany(own, { $unset: { reviewer: '' } });
  await Task.updateMany({ ...open, ...own, status: 'pending_review' }, {
    $set: { status: 'in_progress' }, $unset: { submittedAt: '', submittedBy: '' },
  });
  await migrations.updateOne({ _id: ID }, { $setOnInsert: { completedAt: new Date() } }, { upsert: true });
  return { employeeTasks: employeeTasks.modifiedCount, employeeSchedules: employeeSchedules.modifiedCount, ownTasks: ownTasks.modifiedCount, ownSchedules: ownSchedules.modifiedCount, employee: sathya.name, reviewer: krupali.name };
}

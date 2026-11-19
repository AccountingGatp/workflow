import mongoose from 'mongoose';
import { Client, ClientProject, User, ProjectWorkItem, TaskTemplate, ClientPermission } from './models/index.js';
import { canSeeClient } from './services/access.js';
import { generateRecurringTasks } from './services/recurrence.js';

const MIGRATION_ID = 'bluntd-loan-reminders-2026-11-13-v1';
export async function seedLoanReminders() {
  const migrations = mongoose.connection.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id: MIGRATION_ID, state: 'completed' })) return { alreadyApplied: true };
  const client = await Client.findOne({ name: /^Republic Supply Company LLC$/i });
  const project = client && await ClientProject.findOne({ client: client._id, name: /^Bluntd$/i });
  const sathya = await User.findOne({ email: 'sathya.p@gatpsolutions.com', active: true, deletedAt: null });
  const actor = await User.findOne({ role: 'super_admin', active: true, deletedAt: null });
  if (!project || !sathya || !actor) return { skipped: 'Existing Bluntd project, Sathya account or Super Admin unavailable' };
  const now = new Date();
  try {
    // A lease lets an interrupted deployment retry without concurrent imports.
    const claim = await migrations.findOneAndUpdate({ _id: MIGRATION_ID, state: { $ne: 'completed' }, $or: [{ leaseUntil: { $lt: now } }, { leaseUntil: { $exists: false } }] },
      { $set: { state: 'running', leaseUntil: new Date(now.getTime() + 300000) } }, { upsert: true, returnDocument: 'after' });
    if (!claim) return { running: true };
  } catch (e) { if (e.code === 11000) return { running: true }; throw e; }
  try {
    await Promise.all([TaskTemplate.init(), ProjectWorkItem.init()]);
    if (!(await canSeeClient(sathya, client._id))) await ClientPermission.create({ client: client._id, user: sathya._id, grantedBy: actor._id });
    const loans = [
      { key: 'mercedes', title: 'Auto Loan Mercedes — monthly payment reminder', day: 12, paid: '10/15/2026', assigned: true },
      { key: 'insurance', title: 'First insurance funding loan — monthly payment reminder', day: 20, paid: '10/23/2026' },
      { key: 'ford', title: 'Ford van loan — monthly payment reminder', day: 20, paid: '10/21/2026' },
      { key: 'td', title: 'TD Auto finance loan — monthly payment reminder', day: 20, paid: '10/22/2026' },
    ];
    for (const loan of loans) {
      const key = `${MIGRATION_ID}-${loan.key}`;
      const assignees = loan.assigned ? [sathya._id] : [];
      const instructions = `Monthly loan payment reminder on day ${loan.day}. Screenshot last paid: ${loan.paid} (historical reference, not payment verification). Verify payment status, follow up if required, and record confirmation before marking the task complete.${loan.assigned ? '' : ' Assignee pending manager confirmation.'}`;
      const master = await ProjectWorkItem.findOneAndUpdate({ project: project._id, sourceKey: key }, { $setOnInsert: {
        project: project._id, client: client._id, title: loan.title, category: 'Loans', frequency: 'Monthly', executionDay: String(loan.day), responsible: loan.assigned ? sathya.name : 'Unassigned — awaiting confirmation', responsibleUser: assignees[0], notes: instructions, active: true,
      } }, { upsert: true, returnDocument: 'after' });
      const template = await TaskTemplate.findOneAndUpdate({ importKey: key }, { $setOnInsert: {
        title: loan.title, client: client._id, project: project._id, masterItem: master._id,
        frequency: 'monthly', monthDay: loan.day, startsOn: now, assignees, owner: assignees[0],
        sop: instructions, checklist: ['Check loan payment status and record confirmation'], createdBy: actor._id, active: true,
      } }, { upsert: true, returnDocument: 'after' });
      await ProjectWorkItem.updateOne({ _id: master._id }, { $set: { scheduledTemplate: template._id } });
      await generateRecurringTasks(template._id);
    }
    await migrations.updateOne({ _id: MIGRATION_ID }, { $set: { state: 'completed', completedAt: new Date(), reminders: 4 }, $unset: { leaseUntil: '' } });
    return { created: 4, assigned: 1, unassigned: 3 };
  } catch (e) {
    await migrations.updateOne({ _id: MIGRATION_ID }, { $set: { state: 'failed' }, $unset: { leaseUntil: '' } });
    throw e;
  }
}

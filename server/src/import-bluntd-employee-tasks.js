import mongoose from 'mongoose';
import { Client, ClientProject, User, ProjectWorkItem, TaskTemplate, Task, ClientPermission } from './models/index.js';
import { bluntdSourceWorkItems } from './seed-bluntd-work.js';
import { generateRecurringTasks } from './services/recurrence.js';

const MIGRATION_ID = 'bluntd_tasks_accounts_2026_11_05_v2';

// Only schedules with an explicit owner AND an unambiguous execution date.
// Tasks with absent owners, conflicting dates, or unsupported biweekly/conditional
// cadence remain in the master task list for manager confirmation.
const schedules = {
  1: { frequency: 'daily' },
  3: { frequency: 'monthly', monthDay: 5 },
  4: { frequency: 'monthly', monthDay: 15 },
  5: { frequency: 'daily' },
  6: { frequency: 'daily' },
  13: { frequency: 'weekly', weekday: 5 },
  15: { frequency: 'daily' },
  16: { frequency: 'weekly', weekday: 4 },
  17: { frequency: 'monthly', monthDay: 12 },
  26: { frequency: 'weekly', weekday: 3 },
  28: { frequency: 'weekly', weekday: 3 },
};

const userEmail = { Krupali: 'krupali.s@gatpsolutions.com', Satya: 'sathya.p@gatpsolutions.com' };
const sourceIndex = item => Number(item.sourceKey.replace('bluntd-sheet-row-', ''));
export async function importBluntdTasksOnce() {
  const db = mongoose.connection.db;
  const migrations = db.collection('workflow_migrations');
  const existing = await migrations.findOne({ _id: MIGRATION_ID });
  if (existing?.state === 'completed' || existing?.state === 'running') return;
  if (!existing) {
    try { await migrations.insertOne({ _id: MIGRATION_ID, state: 'running', startedAt: new Date() }); }
    catch (err) { if (err.code === 11000) return; throw err; }
  } else {
    const claim = await migrations.updateOne(
      { _id: MIGRATION_ID, state: 'failed' },
      { $set: { state: 'running', restartedAt: new Date() } },
    );
    if (!claim.modifiedCount) return;
  }

  try {
    const client = await Client.findOne({ name: /^Republic Supply Company LLC$/i }).select('_id');
    if (!client) throw new Error('Republic Supply client not found');
    const project = await ClientProject.findOne({ client: client._id, name: /^Bluntd$/i }).select('_id');
    if (!project) throw new Error('Bluntd project not found');

    const users = {};
    for (const [name, email] of Object.entries(userEmail)) {
      const person = await User.findOne({ email, deletedAt: null, active: true }).select('_id name email role');
      if (!person) throw new Error('Bluntd import requires active existing employee account: ' + email);
      users[name] = person;
    }

    const filter = { client: client._id, project: project._id };
    const before = {
      register: await ProjectWorkItem.countDocuments(filter),
      schedules: await TaskTemplate.countDocuments(filter),
      occurrences: await Task.countDocuments(filter),
    };
    // The earlier project reset was explicitly requested. Do not wipe or
    // replace any newer work manually entered since the reset.
    if (before.register || before.schedules || before.occurrences) {
      throw new Error('Bluntd contains new data; refusing to overwrite it automatically');
    }

    for (const src of bluntdSourceWorkItems) {
      const owner = src.responsible === 'Krupali' ? users.Krupali : src.responsible === 'Satya' ? users.Satya : undefined;
      await ProjectWorkItem.updateOne(
        { project: project._id, sourceKey: src.sourceKey },
        { $setOnInsert: {
          ...src, client: client._id, project: project._id,
          responsible: owner ? owner.name : (src.responsible || ''),
          responsibleUser: owner?._id,
          // Source reminder column ("Done") is source metadata, not a completion action.
        } },
        { upsert: true },
      );
    }

    // Explicit work permission: grant only to scheduled assignees who lack it,
    // never alter existing permissions. Required for task visibility.
    for (const person of Object.values(users)) {
      const existingPerm = await ClientPermission.exists({
        client: client._id, user: person._id, revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      });
      if (!existingPerm && person.role !== 'super_admin') {
        await ClientPermission.create({
          client: client._id, user: person._id, level: 'work',
          grantedBy: undefined, // imported from explicitly supplied employee task roster
        });
      }
    }

    let createdSchedules = 0;
    let createdOccurrences = 0;
    for (const [indexString, timing] of Object.entries(schedules)) {
      const index = Number(indexString);
      const src = bluntdSourceWorkItems.find(item => sourceIndex(item) === index);
      const owner = src?.responsible === 'Krupali' ? users.Krupali : src?.responsible === 'Satya' ? users.Satya : null;
      if (!src || !owner) throw new Error('Scheduled work missing explicit owner at source row ' + index);
      const workItem = await ProjectWorkItem.findOne({ project: project._id, sourceKey: src.sourceKey }).select('_id title');
      if (!workItem) throw new Error('Missing master work item ' + src.sourceKey);
      const sopLinks = (src.links || []).filter(l => /sop|loom|tango/i.test(l.label));
      const instructions = [
        src.software ? 'Software: ' + src.software : '',
        src.executionDay ? 'Source execution day: ' + src.executionDay : '',
        ...sopLinks.map(l => l.label + ': ' + l.url),
      ].filter(Boolean).join('\n');
      // Retry-safe: project+masterItem uniquely identifies a source schedule for this import.
      // Schedules are only created if absent.
      const tpl = await TaskTemplate.findOneAndUpdate(
        { project: project._id, masterItem: workItem._id },
        { $setOnInsert: {
          title: src.title, client: client._id, project: project._id,
          masterItem: workItem._id, owner: owner._id, assignees: [owner._id],
          ...timing, active: true, startsOn: new Date(), sop: instructions,
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      await ProjectWorkItem.updateOne({ _id: workItem._id }, { $set: { scheduledTemplate: tpl._id } });
      createdSchedules++;
      createdOccurrences += await generateRecurringTasks(tpl._id);
    }

    const after = {
      register: await ProjectWorkItem.countDocuments(filter),
      schedules: await TaskTemplate.countDocuments(filter),
      occurrences: await Task.countDocuments(filter),
      linkedOwners: await ProjectWorkItem.countDocuments({ ...filter, responsibleUser: { $ne: null } }),
      linkedSchedules: await ProjectWorkItem.countDocuments({ ...filter, scheduledTemplate: { $ne: null } }),
    };
    if (after.register !== 28 || after.schedules !== Object.keys(schedules).length ||
      after.linkedSchedules !== Object.keys(schedules).length || after.linkedOwners < 1) {
      throw new Error('Bluntd import verification failed: ' + JSON.stringify(after));
    }
    await migrations.updateOne({ _id: MIGRATION_ID }, {
      $set: { state: 'completed', completedAt: new Date(), client: client._id,
        project: project._id, before, after,
        assignedEmails: Object.values(users).map(u => u.email) },
    });
    console.info('BLUNTD EMPLOYEE TASK IMPORT VERIFIED IN MONGODB:', { before, after,
      accounts: Object.values(users).map(u => ({ email: u.email, name: u.name })),
      schedules: createdSchedules, occurrencesCreated: createdOccurrences });
  } catch (err) {
    await migrations.updateOne({ _id: MIGRATION_ID }, {
      $set: { state: 'failed', failedAt: new Date(), failure: String(err.message || err).slice(0, 350) },
    });
    throw err;
  }
}

import mongoose from 'mongoose';
import { Client, ClientProject, ProjectWorkItem, Task, TaskTemplate } from './models/index.js';

// One-time, requested reset of Bluntd. Retain the client and Bluntd project identity.
// Never run again after it has been marked complete; new work entered later is preserved.
const MIGRATION_ID = 'bluntd_clear_import_2026_11_05_v1';

export async function resetBluntdImportedDataOnce() {
  const db = mongoose.connection.db;
  const migrations = db.collection('workflow_migrations');
  const done = await migrations.findOne({ _id: MIGRATION_ID, state: 'completed' });
  if (done) return;
  // This guard prevents two Vercel instances from deleting records concurrently.
  const claim = await migrations.updateOne(
    { _id: MIGRATION_ID },
    { $setOnInsert: { state: 'running', startedAt: new Date() } },
    { upsert: true },
  ).catch(async error => {
    if (error.code !== 11000) throw error;
    return { upsertedCount: 0 };
  });
  if (!claim.upsertedCount) return;

  const client = await Client.findOne({ name: /^Republic Supply Company LLC$/i }).select('_id');
  if (!client) throw new Error('Bluntd reset: Republic Supply Company LLC not found');
  const project = await ClientProject.findOne({ client: client._id, name: /^Bluntd$/i }).select('_id name');
  if (!project) throw new Error('Bluntd reset: Bluntd project not found');

  const filter = { client: client._id, project: project._id };
  const before = {
    master: await ProjectWorkItem.countDocuments(filter),
    tasks: await Task.countDocuments(filter),
    schedules: await TaskTemplate.countDocuments(filter),
  };
  // Stop generators before deleting occurrences. Only Bluntd project records
  // are affected. Completed occurrences are explicitly part of this reset.
  await TaskTemplate.deleteMany(filter);
  await Task.deleteMany(filter);
  await ProjectWorkItem.deleteMany(filter);

  await ClientProject.updateOne(
    { _id: project._id, client: client._id },
    { $set: {
      description: '', businessType: '', website: '', contacts: [], team: [],
      scope: [], excluded: [], links: [], tools: [], automations: [],
      quality: [], guarantees: [], notes: '',
    } },
  );

  const after = {
    master: await ProjectWorkItem.countDocuments(filter),
    tasks: await Task.countDocuments(filter),
    schedules: await TaskTemplate.countDocuments(filter),
  };
  if (Object.values(after).some(Boolean)) {
    throw new Error('Bluntd reset incomplete: remaining records: ' + JSON.stringify(after));
  }
  const saved = await ClientProject.findById(project._id).lean();
  if (!saved || saved.name !== 'Bluntd' || saved.scope?.length || saved.links?.length || saved.contacts?.length) {
    throw new Error('Bluntd reset verification failed: project identity or profile not clean');
  }
  await migrations.updateOne({ _id: MIGRATION_ID }, {
    $set: { state: 'completed', completedAt: new Date(), client: client._id, project: project._id, deletedCounts: before },
  });
  console.info('Bluntd RESET VERIFIED: project retained, imported data cleared', { before, after, projectName: saved.name });
}

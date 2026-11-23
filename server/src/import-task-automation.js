import { createHash } from 'node:crypto';
import { ClientProject, ProjectWorkItem } from './models/index.js';

const key = (value) => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export async function importTaskAutomation(input) {
  const groups = JSON.parse(input);
  if (!Array.isArray(groups) || !groups.length || groups.length > 100 || groups.some((group) =>
    !Array.isArray(group?.projects) || !group.projects.length || group.projects.some((name) => typeof name !== 'string' || !key(name)) ||
    !Array.isArray(group.tasks) || group.tasks.length > 1000 || group.tasks.some((task) =>
      typeof task?.title !== 'string' || !key(task.title) || typeof task.automated !== 'boolean'))) {
    throw new Error('Invalid task automation list');
  }
  const _id = 'workflow-task-automation-' + createHash('sha256').update(input).digest('hex');
  const migrations = ProjectWorkItem.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id })) return null;
  return ProjectWorkItem.db.transaction(async (session) => {
    if (await migrations.findOne({ _id }, { session })) return null;
    await migrations.insertOne({ _id, createdAt: new Date() }, { session });
    const projects = await ClientProject.find({ deletedAt: null }).select('name').session(session).lean();
    const counts = { yes: 0, no: 0, alreadySet: 0, unresolved: [] };
    for (const [groupIndex, group] of groups.entries()) {
      const aliases = new Set(group.projects.map(key));
      const ids = projects.filter(({ name }) => aliases.has(key(name))).map(({ _id }) => _id);
      const tasks = ids.length ? await ProjectWorkItem.find({ project: { $in: ids }, active: { $ne: false } })
        .select('title project automationStatus').session(session).lean() : [];
      const updates = [];
      for (const [taskIndex, row] of group.tasks.entries()) {
        const matches = tasks.filter(({ title }) => key(title) === key(row.title));
        if (matches.length !== 1) {
          counts.unresolved.push([groupIndex + 1, taskIndex + 1, matches.length ? 'ambiguous' : 'missing']);
          continue;
        }
        const [item] = matches;
        if (item.automationStatus !== undefined) {
          counts.alreadySet++;
          continue;
        }
        item.automationStatus = row.automated;
        updates.push({ updateOne: { filter: { _id: item._id, automationStatus: { $exists: false } },
          update: { $set: { automationStatus: row.automated } } } });
        counts[row.automated ? 'yes' : 'no']++;
      }
      if (updates.length) await ProjectWorkItem.bulkWrite(updates, { session });
    }
    await migrations.updateOne({ _id }, { $set: { completedAt: new Date(), counts } }, { session });
    return counts;
  }).catch(async (error) => {
    if (error.code === 11000 && await migrations.findOne({ _id })) return null;
    throw error;
  });
}

import { ClientProject, ProjectWorkItem, TaskTemplate, User } from './models/index.js';

const migrationId = 'detach-bluntd-master-task-schedules-2026-11-26';
const projectId = '6aec5d52b35e33f721f6fd12';
const pairs = [
  ['6af6cfd63bd31663ac2ea038', '6af6cfd63bd31663ac2ea039'],
  ['6aec726ab35e33f721f8afb0', '6aec726db35e33f721f8afd6'],
  ['6aec726ab35e33f721f8afb2', '6aec726eb35e33f721f8afda'],
  ['6aec726ab35e33f721f8afb1', '6aec726db35e33f721f8afd8'],
  ['6aec726bb35e33f721f8afc7', '6aec7272b35e33f721f8b007'],
  ['6aec726cb35e33f721f8afc9', '6aec7272b35e33f721f8b00a'],
  ['6af6cfd73bd31663ac2ea03a', '6af6cfd73bd31663ac2ea03b'],
  ['6af6cfd73bd31663ac2ea03d', '6af6cfd73bd31663ac2ea03e'],
  ['6aec726ab35e33f721f8afae', '6aec726cb35e33f721f8afca'],
  ['6aec726ab35e33f721f8afb3', '6aec726fb35e33f721f8afe6'],
  ['6aec726bb35e33f721f8afbe', '6aec7272b35e33f721f8b005'],
  ['6aec726bb35e33f721f8afba', '6aec7270b35e33f721f8aff2'],
  ['6aec726bb35e33f721f8afbc', '6aec7270b35e33f721f8aff5'],
  ['6aec726bb35e33f721f8afbd', '6aec7271b35e33f721f8b001'],
  ['6af6cfd73bd31663ac2ea040', '6af6cfd73bd31663ac2ea041'],
];

export async function detachBluntdRecurringLinks() {
  const migrations = ClientProject.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id: migrationId })) return null;
  if (!await ClientProject.exists({ _id: projectId, name: 'Bluntd', deletedAt: null })) return null;

  try {
    return await ClientProject.db.transaction(async (session) => {
      if (await migrations.findOne({ _id: migrationId }, { session })) return null;
      await migrations.insertOne({ _id: migrationId, createdAt: new Date() }, { session });
      const people = await User.distinct('_id', {
        email: { $in: ['sathya.p@gatpsolutions.com', 'krupali.s@gatpsolutions.com'] },
      }).session(session);
      let detached = 0;
      for (const [masterId, templateId] of pairs) {
        const matched = await ProjectWorkItem.updateOne({
          _id: masterId, project: projectId, scheduledTemplate: templateId,
        }, { $unset: { scheduledTemplate: 1 } }, { session });
        if (!matched.modifiedCount) continue;
        await ProjectWorkItem.updateOne({
          _id: masterId, project: projectId, responsibleUser: { $in: people },
        }, { $unset: { responsibleUser: 1 } }, { session });
        await TaskTemplate.updateOne({
          _id: templateId, project: projectId, masterItem: masterId,
        }, { $set: { active: false, assignees: [] }, $unset: { masterItem: 1, owner: 1 } }, { session });
        detached++;
      }
      await migrations.updateOne({ _id: migrationId }, { $set: { detached, completedAt: new Date() } }, { session });
      return detached;
    });
  } catch (error) {
    if (error.code === 11000 && await migrations.findOne({ _id: migrationId })) return null;
    throw error;
  }
}

import { createHash } from 'node:crypto';
import { Client, ClientProject } from './models/index.js';
import { dailyModels } from './daily-work/models.js';

const normalize = (name) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function parseProjects(input) {
  const rows = JSON.parse(input);
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('Invalid project import');
  return rows.map((row) => {
    const names = Array.isArray(row) ? row : [row];
    if (!names.length || names.some((name) => typeof name !== 'string' ||
      !normalize(name) || name.trim().length > 120)) throw new Error('Invalid project name or alias');
    return { name: names[0].trim(), keys: new Set(names.map(normalize)) };
  });
}

async function linkDailyProject(Project, row, project, session) {
  const workflowProjectId = String(project._id);
  const result = await Project.updateOne({
    _id: row._id, workflowProjectId: null, archived: { $ne: true },
  }, { $set: { workflowProjectId } }, { session });
  if (!result.modifiedCount) throw new Error('Daily Work project changed during import');
  row.workflowProjectId = workflowProjectId;
}

export async function importWorkflowProjects(input) {
  const _id = 'workflow-project-import-' + createHash('sha256').update(input).digest('hex');
  const migrations = Client.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id })) return null;
  const requested = parseProjects(input);
  const { Project } = await dailyModels();
  if (Project.db.getClient() !== Client.db.getClient()) {
    throw new Error('Project import requires Workflow and Daily Work on the same MongoDB connection');
  }

  try {
    return await Client.db.transaction(async (session) => {
      // Claim this batch inside the transaction so concurrent cron invocations cannot import it twice.
      if (await migrations.findOne({ _id }, { session })) return null;
      await migrations.insertOne({ _id, createdAt: new Date() }, { session });
      const clients = await Client.find().select('name status standaloneProject').session(session).lean();
      const current = await ClientProject.find().select('name client deletedAt').session(session).lean();
      const daily = await Project.find().select('name clientId workflowProjectId archived').session(session).lean();
      const clientById = new Map(clients.map((client) => [String(client._id), client]));
      const counts = { added: 0, reusedDailyWork: 0, existing: 0, skipped: 0 };

      for (const { name, keys } of requested) {
        const matches = ({ name }) => keys.has(normalize(name));
        const dailyMatches = daily.filter(matches);
        const linkedIds = new Set(dailyMatches.map(({ workflowProjectId }) => workflowProjectId).filter(Boolean));
        const existingProjects = current.filter((row) => matches(row) || linkedIds.has(String(row._id)));
        const [existingProject] = existingProjects;
        const [existingDaily] = dailyMatches;
        if (existingProjects.length) {
          if (existingProjects.every((row) => row.deletedAt)) {
            counts.skipped++;
            continue;
          }
          if (existingProjects.length === 1 && dailyMatches.length === 1 && !existingProject.deletedAt &&
            !existingDaily.archived && !existingDaily.workflowProjectId &&
            existingDaily.clientId === String(existingProject.client) &&
            !daily.some(({ workflowProjectId }) => workflowProjectId === String(existingProject._id))) {
            await linkDailyProject(Project, existingDaily, existingProject, session);
            counts.reusedDailyWork++;
          }
          counts.existing++;
          continue;
        }
        const matchingClients = clients.filter((client) => !client.standaloneProject && matches(client));
        const parent = existingDaily ? clientById.get(existingDaily.clientId) : matchingClients[0];
        if (dailyMatches.length > 1 || (!existingDaily && matchingClients.length > 1) ||
          existingDaily?.archived || existingDaily?.workflowProjectId || parent?.status === 'inactive' ||
          (existingDaily && !parent)) {
          counts.skipped++;
          continue;
        }

        const [workspace] = parent ? [parent] : await Client.create([{ name, standaloneProject: true }], { session });
        const [project] = await ClientProject.create([{
          name: existingDaily?.name || name, client: workspace._id,
        }], { session });
        current.push(project);
        if (existingDaily) {
          await linkDailyProject(Project, existingDaily, project, session);
          counts.reusedDailyWork++;
        }
        counts.added++;
      }

      await migrations.updateOne({ _id }, { $set: { completedAt: new Date(), counts } }, { session });
      return counts;
    });
  } catch (error) {
    if (error.code === 11000 && await migrations.findOne({ _id })) return null;
    throw error;
  }
}

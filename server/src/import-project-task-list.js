import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Client, ClientProject, ProjectWorkItem, User } from './models/index.js';
import { dailyModels } from './daily-work/models.js';
import { visibleClientIds } from './services/access.js';

const key = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Prefer the canonical name, then the worksheet's known aliases. Ambiguous matches never pick a client arbitrarily.
function matchName(rows, names) {
  for (const name of names) {
    const matches = rows.filter((row) => key(row.name) === key(name));
    if (matches.length) return matches;
  }
  return [];
}

const validLink = ({ label, url }) => typeof label === 'string' && /^https:\/\//i.test(url || '');

function findAssignee(people, name) {
  if (!name || /[\/,;&]/.test(name)) return undefined;
  const exact = matchName(people, [name]);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const first = key(name);
  const matches = people.filter((person) => key(person.name.split(/\s+/)[0]) === first);
  return matches.length === 1 ? matches[0] : undefined;
}

function projectTasks(input) {
  const groups = JSON.parse(gunzipSync(Buffer.from(input, 'base64'), { maxOutputLength: 1000000 }).toString('utf8'));
  if (!Array.isArray(groups) || groups.length > 100) throw new Error('Invalid project task list');
  for (const { names, tasks } of groups) {
    if (!Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string' || !key(name) || name.length > 120) ||
      !Array.isArray(tasks) || tasks.length > 1000 || tasks.some((task) => typeof task.title !== 'string' || !key(task.title) || task.title.length > 180)) {
      throw new Error('Invalid project or task name');
    }
  }
  return groups;
}

export async function importProjectTaskList(input) {
  const _id = 'workflow-project-tasks-' + createHash('sha256').update(input).digest('hex');
  const migrations = Client.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id })) return null;
  const groups = projectTasks(input);
  const { Project } = await dailyModels();
  if (Project.db.getClient() !== Client.db.getClient()) throw new Error('Project task import needs a shared MongoDB connection');

  const people = await User.find({ active: true, deletedAt: null }).select('name role').lean();
  const assignedNames = new Set(groups.flatMap(({ tasks }) => tasks.map(({ responsible }) => responsible).filter(Boolean)));
  const assignees = new Map([...assignedNames].map((name) => [name, findAssignee(people, name)]));
  const access = new Map(await Promise.all([...new Set([...assignees.values()].filter(Boolean))].map(async (person) =>
    [String(person._id), await visibleClientIds(person)])));

  try {
    return await Client.db.transaction(async (session) => {
      if (await migrations.findOne({ _id }, { session })) return null;
      await migrations.insertOne({ _id, createdAt: new Date() }, { session });
      const clients = await Client.find().select('name status standaloneProject').session(session).lean();
      const projects = await ClientProject.find().select('name client deletedAt').session(session).lean();
      const daily = await Project.find().select('name workflowProjectId clientId archived').session(session).lean();
      const counts = { projects: 0, projectsCreated: 0, added: 0, existing: 0, skipped: 0, manualTime: 0, assigneesLinked: 0, assigneesByName: 0 };

      for (const { names, tasks } of groups) {
        const matches = matchName(projects, names);
        const dailyMatches = matchName(daily, names);
        const [dailyProject] = dailyMatches;
        let [project] = matches;
        if (!project && dailyMatches.length === 1 && dailyProject.workflowProjectId) {
          project = projects.find((row) => String(row._id) === dailyProject.workflowProjectId);
        }
        const clientMatches = dailyProject ? clients.filter((row) => String(row._id) === dailyProject.clientId)
          : matchName(clients.filter((row) => !row.standaloneProject), names);
        if (matches.length > 1 || project?.deletedAt || (!project && (dailyMatches.length > 1 ||
          dailyProject?.archived || dailyProject?.workflowProjectId || (dailyProject && !clientMatches.length) ||
          clientMatches.length > 1 || clientMatches[0]?.status === 'inactive'))) {
          counts.skipped += tasks.length;
          continue;
        }
        if (!project) {
          const [parent] = clientMatches.length ? clientMatches : await Client.create([{
            name: names[0], standaloneProject: true,
          }], { session });
          [project] = await ClientProject.create([{
            client: parent._id, name: dailyProject?.name || names[0],
          }], { session });
          projects.push(project);
          counts.projectsCreated++;
        }
        if (dailyMatches.length === 1 && !dailyProject.archived && !dailyProject.workflowProjectId &&
          dailyProject.clientId === String(project.client) &&
          !daily.some((row) => row.workflowProjectId === String(project._id))) {
          const workflowProjectId = String(project._id);
          const updated = await Project.updateOne({ _id: dailyProject._id, workflowProjectId: null, archived: { $ne: true } },
            { $set: { workflowProjectId } }, { session });
          if (!updated.modifiedCount) throw new Error('Daily Work project changed during task import');
          dailyProject.workflowProjectId = workflowProjectId;
        }
        counts.projects++;
        const existing = await ProjectWorkItem.find({ project: project._id }).select('title').session(session).lean();
        const titles = new Set(existing.map(({ title }) => key(title)));
        const inserts = [];
        for (const task of tasks) {
          const titleKey = key(task.title);
          if (titles.has(titleKey)) { counts.existing++; continue; }
          titles.add(titleKey);
          const { title, notes, frequency, weeklyHours, responsible, automated, links } = task;
          const person = assignees.get(responsible);
          const scopes = person && access.get(String(person._id));
          const responsibleUser = person && (scopes === null || scopes?.includes(String(project.client))) ? person._id : undefined;
          if (responsibleUser) counts.assigneesLinked++;
          else if (responsible) counts.assigneesByName++;
          const estimate = typeof weeklyHours === 'string' ? weeklyHours.trim() : '';
          if (!estimate) counts.manualTime++;
          inserts.push({
            project: project._id, client: project.client, title, notes, frequency,
            ...(estimate && { weeklyHours: estimate }),
            responsible, responsibleUser, automated,
            links: Array.isArray(links) ? links.filter(validLink) : [],
          });
        }
        if (inserts.length) await ProjectWorkItem.insertMany(inserts, { session });
        counts.added += inserts.length;
      }
      await migrations.updateOne({ _id }, { $set: { completedAt: new Date(), counts } }, { session });
      return counts;
    });
  } catch (error) {
    if (error.code === 11000 && await migrations.findOne({ _id })) return null;
    throw error;
  }
}

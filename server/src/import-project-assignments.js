import { createHash } from 'node:crypto';
import { Client, ClientProject, ProjectPermission, User } from './models/index.js';
import { grantedProjectIds, visibleClientIds } from './services/access.js';

const normalize = (name) => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const validNames = (names) => Array.isArray(names) && names.length > 0 &&
  names.every((name) => typeof name === 'string' && name.length <= 160 && normalize(name));

function match(rows, names) {
  for (const name of names) {
    const matched = rows.get(normalize(name));
    if (matched?.length) return matched;
  }
  return [];
}

function byName(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const name = normalize(row.name);
    if (!lookup.has(name)) lookup.set(name, []);
    lookup.get(name).push(row);
  }
  return lookup;
}

export async function importProjectAssignments(input) {
  const batch = JSON.parse(input);
  if (!Array.isArray(batch) || !batch.length || batch.length > 200 || batch.some((row) =>
    !validNames(row?.person) || !Array.isArray(row.projects) || row.projects.length > 100 || !row.projects.every(validNames))) {
    throw new Error('Invalid project assignment list');
  }
  const _id = 'workflow-project-assignments-' + createHash('sha256').update(input).digest('hex');
  const migrations = Client.db.collection('workflow_migrations');
  if (await migrations.findOne({ _id })) return null;

  const [users, clients] = await Promise.all([
    User.find({ active: true, deletedAt: null }).select('name role').lean(),
    Client.distinct('_id', { status: { $ne: 'inactive' } }),
  ]);
  const projects = byName(await ClientProject.find({ client: { $in: clients }, deletedAt: null })
    .select('name client').lean());
  const people = byName(users);
  const counts = { added: 0, existing: 0, unresolved: [] };
  const grants = [];

  for (const [personIndex, { person, projects: requested }] of batch.entries()) {
    const [user, anotherUser] = match(people, person);
    if (!user || anotherUser) {
      counts.unresolved.push({ person: personIndex + 1, reason: user ? 'multiple people' : 'person missing' });
      continue;
    }
    const [visible, granted] = await Promise.all([visibleClientIds(user), grantedProjectIds(user)]);
    const projectIds = new Set(granted.map(String));
    const hasAccess = (project) => visible === null ||
      visible.includes(String(project.client)) || projectIds.has(String(project._id));
    for (const [projectIndex, names] of requested.entries()) {
      const matches = [...new Set(names.flatMap((name) => projects.get(normalize(name)) || []))];
      if (matches.length !== 1) {
        if (matches.length && matches.filter(hasAccess).length === 1) counts.existing++;
        else counts.unresolved.push({ person: personIndex + 1, project: projectIndex + 1,
          reason: matches.length ? 'multiple projects' : 'project missing' });
        continue;
      }
      const [project] = matches;
      if (hasAccess(project)) counts.existing++;
      else {
        grants.push({ project: project._id, user: user._id });
        projectIds.add(String(project._id));
      }
    }
  }
  try {
    return await Client.db.transaction(async (session) => {
      if (await migrations.findOne({ _id }, { session })) return null;
      await migrations.insertOne({ _id, createdAt: new Date() }, { session });
      const result = grants.length ? await ProjectPermission.bulkWrite(grants.map((filter) => ({
        updateOne: { filter, update: { $setOnInsert: filter }, upsert: true },
      })), { session }) : null;
      const added = result?.upsertedCount || 0;
      const outcome = { ...counts, added, existing: counts.existing + grants.length - added };
      await migrations.updateOne({ _id }, { $set: { outcome, completedAt: new Date() } }, { session });
      return outcome;
    });
  } catch (error) {
    if (error.code === 11000 && await migrations.findOne({ _id })) return null;
    throw error;
  }
}

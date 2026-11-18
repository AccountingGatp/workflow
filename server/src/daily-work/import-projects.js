import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Client, ClientProject } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { catalogCollation, ensureReviewCatalog } from './budgets.js';

const key = (name) => name.normalize('NFKC').trim().toLowerCase();

export function parseProjectNames(text) {
  if (typeof text !== 'string') throw new HttpError(400, 'Upload or paste the project list');
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (key(rows[0] || '') === 'project/client name') rows.shift();
  if (!rows.length || rows.length > 1000 || rows.some((line) => line.length > 120 || line.includes('\t'))) {
    throw new HttpError(400, 'Enter 1 to 1,000 project names, one per line, at most 120 characters each');
  }
  const names = new Map();
  for (const name of rows) if (!names.has(key(name))) names.set(key(name), name);
  return { names: [...names.values()], duplicates: rows.length - names.size };
}

function byName(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const name = key(row.name);
    const list = byKey.get(name) || [];
    list.push(row);
    byKey.set(name, list);
  }
  return byKey;
}

function newClientId(name) {
  const hex = createHash('sha256').update('workflow-daily-work-client:' + key(name)).digest('hex').slice(0, 24);
  return new Types.ObjectId(hex);
}

export async function importDailyProjects(models, text) {
  const { names, duplicates } = parseProjectNames(text);
  const [clients, workflowProjects, dailyProjects] = await Promise.all([
    Client.find().select('name').lean(),
    ClientProject.find().select('name client').lean(),
    models.Project.find().lean(),
  ]);
  const clientNames = byName(clients);
  const workflowNames = byName(workflowProjects);
  const dailyNames = byName(dailyProjects);
  const projectLinks = new Set(dailyProjects.map((project) => project.workflowProjectId).filter(Boolean));
  const newClients = [];
  const planned = [];
  const skipped = [];
  let existing = 0;

  for (const name of names) {
    const normalized = key(name);
    const suffix = name.match(/^(.*?)\s*\(([^()]*)\)$/);
    const explicitClients = suffix ? clientNames.get(key(suffix[2])) : undefined;
    const candidateClients = explicitClients || clientNames.get(normalized) || [];
    const sameClient = (project) => !candidateClients.length ||
      candidateClients.some((client) => String(client._id) === String(project.client));
    let candidates = (workflowNames.get(normalized) || (explicitClients && workflowNames.get(key(suffix[1]))) || [])
      .filter(sameClient);
    if (!candidates.length && explicitClients?.length === 1) {
      candidates = workflowProjects.filter((project) => sameClient(project) && key(suffix[1]).startsWith(key(project.name) + ' '));
    }
    const alreadyNamed = dailyNames.get(normalized) || [];
    if (alreadyNamed.length === 1) { existing++; continue; }
    if (alreadyNamed.length > 1 || candidateClients.length > 1 || candidates.length > 1) {
      skipped.push({ name, reason: 'More than one existing record matches' });
      continue;
    }

    const linked = candidates[0];
    const client = candidateClients[0];
    if (linked && projectLinks.has(String(linked._id))) {
      existing++;
      continue;
    }
    const clientId = linked?.client || client?._id || newClientId(name);
    if (!linked && !client) newClients.push({ _id: clientId, name });
    if (linked) projectLinks.add(String(linked._id));
    planned.push({ name, clientId: String(clientId), ...(linked && { workflowProjectId: String(linked._id) }) });
  }

  if (newClients.length) await Client.bulkWrite(newClients.map(({ _id, name }) => ({ updateOne: {
    filter: { _id }, update: { $setOnInsert: { name, status: 'active', createdAt: new Date() } }, upsert: true, timestamps: false,
  } })));
  const added = await models.Project.db.transaction(async (session) => {
    if (!planned.length) return 0;
    const result = await models.Project.bulkWrite(planned.map((project) => ({ updateOne: {
      filter: { clientId: project.clientId, name: project.name },
      collation: catalogCollation,
      update: { $setOnInsert: { ...project, archived: false, createdAt: new Date() } },
      upsert: true, timestamps: false,
    } })), { session });
    const ids = Object.values(result.upsertedIds).map((_id) => ({ _id }));
    await ensureReviewCatalog(models, ids, session);
    return result.upsertedCount;
  });
  return { added, existing: existing + planned.length - added, duplicates, skipped };
}

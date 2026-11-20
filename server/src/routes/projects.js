import { Router } from 'express';
import mongoose from 'mongoose';
import { Client, ClientAssignment, ClientProject, Task } from '../models/index.js';
import { ah, HttpError, requireRole } from '../middleware/auth.js';
import { canSeeClient, canManageClient, visibleClientIds, audit } from '../services/access.js';

const r = Router();
const valid = (id) => mongoose.isValidObjectId(id);
const safeProject = ({ referenceClient, ...project }, manager) => ({
  ...project,
  links: (project.links || []).filter(link => manager || !link.restricted),
});

function projectDetails(body) {
  const name = String(body?.name || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'Project name must be 1–120 characters');
  return { name, description: String(body?.description || '').slice(0, 3000) };
}

async function visibleReference(user, id) {
  if (!id || !await canSeeClient(user, id)) return null;
  return Client.findOne({ _id: id, standaloneProject: { $ne: true } }).select('name').lean();
}
async function check(req, clientId, manage = false) {
  if (!valid(clientId) || !(await Client.exists({ _id: clientId }))) throw new HttpError(404, 'Client not found');
  if (!(await (manage ? canManageClient : canSeeClient)(req.user, clientId))) throw new HttpError(403, 'Client access denied');
}
r.get('/projects', ah(async (req, res) => {
  const ids = await visibleClientIds(req.user);
  const clients = await Client.find(ids === null ? {} : { _id: { $in: ids } }).select('name standaloneProject').lean();
  const clientInfo = new Map(clients.map((client) => [String(client._id), client]));
  const clientIds = clients.map(({ _id }) => _id);
  const projects = await ClientProject.find({ client: { $in: clientIds } })
    .select('name client referenceClient').sort({ name: 1, _id: 1 }).lean();
  if (!projects.length) return res.json([]);
  const now = new Date();
  const counts = await Task.aggregate([
    { $match: { client: { $in: clientIds }, project: { $in: projects.map(({ _id }) => _id) }, deletedAt: null, status: { $ne: 'done' } } },
    { $group: { _id: '$project', open: { $sum: 1 }, overdue: {
      $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$dueDate', null] }, null] }, { $lt: ['$dueDate', now] }] }, 1, 0] },
    } } },
  ]);
  const byProject = new Map(counts.map((row) => [String(row._id), row]));
  res.json(projects.map(({ referenceClient, ...project }) => {
    const tasks = byProject.get(String(project._id));
    const owner = clientInfo.get(String(project.client));
    const reference = owner.standaloneProject ? clientInfo.get(String(referenceClient)) : owner;
    return {
      ...project,
      clientName: reference?.name,
      clientInfoId: reference?._id,
      openTasks: tasks?.open || 0,
      overdueTasks: tasks?.overdue || 0,
    };
  }));
}));

r.post('/projects', requireRole('super_admin', 'manager', 'admin'), ah(async (req, res) => {
  const details = projectDetails(req.body);
  // A private workspace keeps task and access links stable when client information is added.
  const project = await Client.db.transaction(async (session) => {
    const [workspace] = await Client.create([{ name: details.name, standaloneProject: true }], { session });
    if (req.user.role !== 'super_admin') {
      await ClientAssignment.create([{ client: workspace._id, admin: req.user._id }], { session });
    }
    const [created] = await ClientProject.create([{ ...details, client: workspace._id }], { session });
    return created;
  });
  audit(req.user, 'project.create', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Created project ' + project.name });
  res.status(201).json(project);
}));

r.get('/clients/:clientId/projects', ah(async (req, res) => {
  await check(req, req.params.clientId);
  const manager = await canManageClient(req.user, req.params.clientId);
  const projects = await ClientProject.find({ client: req.params.clientId }).sort({ name: 1 }).lean();
  res.json(projects.map(p => safeProject(p, manager)));
}));
r.get('/clients/:clientId/projects/:id', ah(async (req, res) => {
  await check(req, req.params.clientId);
  if (!valid(req.params.id)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.findOne({ _id: req.params.id, client: req.params.clientId }).lean();
  if (!project) throw new HttpError(404, 'Project not found');
  const [manager, clientReference] = await Promise.all([
    canManageClient(req.user, req.params.clientId),
    visibleReference(req.user, project.referenceClient),
  ]);
  res.json({ ...safeProject(project, manager), clientReference });
}));
r.post('/clients/:clientId/projects', ah(async (req, res) => {
  await check(req, req.params.clientId, true);
  if (await Client.exists({ _id: req.params.clientId, standaloneProject: true })) {
    throw new HttpError(400, 'Create another project from the Projects page');
  }
  const details = projectDetails(req.body);
  const existing = await ClientProject.findOne({ client: req.params.clientId, name: details.name });
  if (existing) throw new HttpError(409, 'Project already exists');
  const project = await ClientProject.create({ ...details, client: req.params.clientId });
  audit(req.user, 'project.create', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Created project ' + project.name });
  res.status(201).json(project);
}));
r.patch('/clients/:clientId/projects/:id/client-reference', ah(async (req, res) => {
  const { clientId, id } = req.params;
  await check(req, clientId, true);
  if (!valid(id)) throw new HttpError(404, 'Project not found');
  if (!await Client.exists({ _id: clientId, standaloneProject: true })) {
    throw new HttpError(400, 'This project already belongs to a client');
  }
  const referenceId = req.body?.clientId;
  if (referenceId !== null && (typeof referenceId !== 'string' || !valid(referenceId))) {
    throw new HttpError(400, 'Select a client or choose No client');
  }
  const clientReference = referenceId ? await visibleReference(req.user, referenceId) : null;
  if (referenceId && !clientReference) throw new HttpError(404, 'Client not found or unavailable');
  const update = clientReference ? { $set: { referenceClient: clientReference._id } } : { $unset: { referenceClient: '' } };
  const project = await ClientProject.findOneAndUpdate({ _id: id, client: clientId }, update);
  if (!project) throw new HttpError(404, 'Project not found');
  audit(req.user, 'project.update', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Updated client information for ' + project.name });
  res.json({ clientReference });
}));

r.patch('/clients/:clientId/projects/:id', ah(async (req, res) => {
  await check(req, req.params.clientId, true);
  if (!valid(req.params.id)) throw new HttpError(404, 'Project not found');
  const keys = ['name', 'description', 'businessType', 'website', 'contacts', 'team', 'scope', 'excluded', 'links', 'tools', 'automations', 'quality', 'guarantees', 'notes'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => keys.includes(k)));
  if (update.name !== undefined && !String(update.name).trim()) throw new HttpError(400, 'Name required');
  for (const key of ['contacts','team','scope','excluded','links','tools','automations','quality','guarantees']) {
    if (key in update && !Array.isArray(update[key])) throw new HttpError(400, key + ' must be a list');
  }
  const project = await ClientProject.findOneAndUpdate({ _id: req.params.id, client: req.params.clientId }, { $set: update }, { new: true, runValidators: true });
  if (!project) throw new HttpError(404, 'Project not found');
  audit(req.user, 'project.update', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Updated project ' + project.name });
  res.json(safeProject(project.toObject(), true));
}));
export default r;

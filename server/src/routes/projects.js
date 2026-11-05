import { Router } from 'express';
import mongoose from 'mongoose';
import { Client, ClientProject } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';
import { canSeeClient, canManageClient, audit } from '../services/access.js';

const r = Router();
const valid = (id) => mongoose.isValidObjectId(id);
const safeProject = (project, manager) => ({
  ...project,
  links: (project.links || []).filter(link => manager || !link.restricted),
});
async function check(req, clientId, manage = false) {
  if (!valid(clientId) || !(await Client.exists({ _id: clientId }))) throw new HttpError(404, 'Client not found');
  if (!(await (manage ? canManageClient : canSeeClient)(req.user, clientId))) throw new HttpError(403, 'Client access denied');
}
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
  res.json(safeProject(project, await canManageClient(req.user, req.params.clientId)));
}));
r.post('/clients/:clientId/projects', ah(async (req, res) => {
  await check(req, req.params.clientId, true);
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'Project name must be 1–120 characters');
  const existing = await ClientProject.findOne({ client: req.params.clientId, name });
  if (existing) throw new HttpError(409, 'Project already exists');
  const project = await ClientProject.create({ client: req.params.clientId, name, description: String(req.body?.description || '').slice(0, 3000) });
  audit(req.user, 'project.create', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Created project ' + name });
  res.status(201).json(project);
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
  res.json(project);
}));
export default r;

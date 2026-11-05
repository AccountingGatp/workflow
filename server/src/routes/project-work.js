import { Router } from 'express';
import mongoose from 'mongoose';
import { Client, ClientProject, ProjectWorkItem, User } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';
import { canSeeClient, canManageClient, audit } from '../services/access.js';

const r = Router();
async function canEditMasterList(user, clientId) {
  // Super Admin, assigned client managers / team leads, or an Admin / TL
  // with explicit access to this client may maintain its task references.
  if (await canManageClient(user, clientId)) return true;
  return user.role === 'admin' && await canSeeClient(user, clientId);
}
async function authorized(req, manager = false) {
  const { clientId, projectId } = req.params;
  if (!mongoose.isValidObjectId(clientId) || !mongoose.isValidObjectId(projectId)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.findOne({ _id: projectId, client: clientId }).select('_id client');
  if (!project) throw new HttpError(404, 'Project not found');
  if (!(await (manager ? canEditMasterList : canSeeClient)(req.user, clientId))) throw new HttpError(403, 'Project access denied');
  return project;
}
function safeLinks(links) {
  if (!Array.isArray(links)) throw new HttpError(400, 'Links must be a list');
  if (links.length > 40) throw new HttpError(400, 'Too many links');
  return links.map(l => {
    const label = String(l.label || '').trim().slice(0, 140);
    const url = String(l.url || '').trim();
    if (!label || !url || !/^https:\/\//i.test(url)) throw new HttpError(400, 'Each reference requires a label and an HTTPS link');
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error('protocol'); }
    catch { throw new HttpError(400, 'Invalid reference URL'); }
    return { label, url };
  });
}
function payload(body) {
  const name = String(body?.title || '').trim();
  if (!name || name.length > 180) throw new HttpError(400, 'Task name must be 1–180 characters');
  const allowed = ['category','responsible','weeklyHours','frequency','executionDay','software','reminder','notes'];
  const result = { title: name };
  for (const k of allowed) if (body[k] !== undefined) result[k] = String(body[k] || '').trim().slice(0, 3000);
  if (body.automated !== undefined) result.automated = !!body.automated;
  if (body.links !== undefined) result.links = safeLinks(body.links);
  if (body.responsibleUser !== undefined) {
    if (body.responsibleUser && !mongoose.isValidObjectId(body.responsibleUser)) throw new HttpError(400, 'Invalid employee');
    result.responsibleUser = body.responsibleUser || null;
  }
  return result;
}
async function resolveAssignedEmployee(data) {
  if (data.responsibleUser) {
    const person = await User.findOne({ _id: data.responsibleUser, active: true, deletedAt: null }).select('name');
    if (!person) throw new HttpError(400, 'Select an active employee');
    data.responsible = person.name;
  }
  return data;
}
r.get('/clients/:clientId/projects/:projectId/work-items/access', ah(async (req, res) => {
  await authorized(req);
  const canEdit = await canEditMasterList(req.user, req.params.clientId);
  const canArchive = await canManageClient(req.user, req.params.clientId);
  res.json({ canEdit, canArchive, role: req.user.role });
}));
r.get('/clients/:clientId/projects/:projectId/work-items', ah(async (req,res) => {
  await authorized(req);
  const items = await ProjectWorkItem.find({ project: req.params.projectId, active: { $ne: false } })
    .sort({ createdAt: 1, _id: 1 }).lean();
  res.json(items);
}));
r.post('/clients/:clientId/projects/:projectId/work-items', ah(async (req,res) => {
  const project = await authorized(req, true);
  const doc = await ProjectWorkItem.create({
    ...await resolveAssignedEmployee(payload(req.body)), client: project.client, project: project._id,
  });
  audit(req.user, 'project.work.create', { entity:'ProjectWorkItem', entityId:doc._id, client:project.client, summary:'Added project work item ' + doc.title });
  res.status(201).json(doc);
}));
r.patch('/clients/:clientId/projects/:projectId/work-items/:id', ah(async (req,res) => {
  const project = await authorized(req, true);
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Work item not found');
  const doc = await ProjectWorkItem.findOneAndUpdate({ _id: req.params.id, project:project._id },
    { $set: await resolveAssignedEmployee(payload(req.body)) }, { new:true, runValidators:true });
  if (!doc) throw new HttpError(404, 'Work item not found');
  audit(req.user, 'project.work.update', { entity:'ProjectWorkItem', entityId:doc._id, client:project.client, summary:'Updated project work item ' + doc.title });
  res.json(doc);
}));
r.delete('/clients/:clientId/projects/:projectId/work-items/:id', ah(async (req,res) => {
  const project = await authorized(req);
  if (!(await canManageClient(req.user, req.params.clientId))) throw new HttpError(403, 'Only client managers may archive project work');
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Work item not found');
  const doc = await ProjectWorkItem.findOneAndUpdate({ _id:req.params.id, project:project._id },
    { $set:{ active:false } }, { new:true });
  if (!doc) throw new HttpError(404, 'Work item not found');
  audit(req.user, 'project.work.archive', { entity:'ProjectWorkItem', entityId:doc._id, client:project.client, summary:'Archived project work item ' + doc.title });
  res.json({ ok:true });
}));
export default r;

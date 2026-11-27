import { Router } from 'express';
import { isObjectIdOrHexString } from 'mongoose';
import { AutomationGroup, ClientProject } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';

const r = Router();
const editors = ['super_admin', 'manager', 'admin'];

r.get('/automations', ah(async (req, res) => {
  const canEdit = editors.includes(req.user.role);
  const groups = await AutomationGroup.find().select('links').lean();
  const byProject = new Map(groups.map((group) => [String(group._id), group.links]));
  const projects = await ClientProject.find({
    deletedAt: null,
    ...(!canEdit && { _id: { $in: groups.map((group) => group._id) } }),
  }).select('name').sort({ name: 1, _id: 1 }).lean();
  res.json(projects.map((project) => ({
    id: project._id,
    name: project.name,
    links: byProject.get(String(project._id)) ?? null,
    canEdit,
  })));
}));

async function manageableProject(req) {
  if (!editors.includes(req.user.role)) throw new HttpError(403, 'Only Admin / TLs, Managers and Super Admins can manage Automations');
  const { projectId } = req.params;
  if (!isObjectIdOrHexString(projectId)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.findOne({ _id: projectId, deletedAt: null }).select('_id').lean();
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}

r.put('/automations/:projectId', ah(async (req, res) => {
  const project = await manageableProject(req);
  await AutomationGroup.updateOne({ _id: project._id }, { $setOnInsert: { links: [] } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });
  res.json({ ok: true });
}));

function readCard(body) {
  const { name, url } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new HttpError(400, 'Enter a tool name up to 120 characters');
  let link;
  try {
    if (typeof url !== 'string' || url.trim().length > 2048) throw new Error();
    link = new URL(url.trim());
    if (link.protocol !== 'https:' || link.username || link.password || link.href.length > 2048) throw new Error();
  } catch {
    throw new HttpError(400, 'Enter a valid HTTPS link');
  }
  return { name: name.trim(), url: link.href };
}

r.post('/automations/:projectId/links', ah(async (req, res) => {
  const project = await manageableProject(req);
  const card = readCard(req.body);
  const result = await AutomationGroup.updateOne({ _id: project._id, 'links.url': { $ne: card.url } },
    { $push: { links: card } }, { runValidators: true });
  if (!result.modifiedCount) {
    if (!await AutomationGroup.exists({ _id: project._id })) throw new HttpError(404, 'Add this project to Automations first');
    throw new HttpError(409, 'This link is already on the project dashboard');
  }
  res.status(201).json(card);
}));

r.patch('/automations/:projectId/links/:linkId', ah(async (req, res) => {
  const project = await manageableProject(req);
  const { linkId } = req.params;
  if (!isObjectIdOrHexString(linkId)) throw new HttpError(404, 'Automation card not found');
  const card = readCard(req.body);
  const match = { _id: project._id, 'links._id': linkId };
  const result = await AutomationGroup.updateOne({
    ...match,
    links: { $not: { $elemMatch: { _id: { $ne: linkId }, url: card.url } } },
  }, { $set: { 'links.$[card].name': card.name, 'links.$[card].url': card.url } },
  { arrayFilters: [{ 'card._id': linkId }], runValidators: true });
  if (!result.matchedCount) {
    if (!await AutomationGroup.exists(match)) throw new HttpError(404, 'Automation card not found');
    throw new HttpError(409, 'This link is already on the project dashboard');
  }
  res.json({ _id: linkId, ...card });
}));

export default r;

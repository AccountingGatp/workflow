import { Router } from 'express';
import { isObjectIdOrHexString } from 'mongoose';
import { AutomationGroup, ClientProject } from '../models/index.js';
import { ah, HttpError } from '../middleware/auth.js';
import { canManageProject } from '../services/access.js';
import { isAssignedProjectManager } from '../services/project-managers.js';
import { visibleProjectDirectory } from './projects.js';

const r = Router();
const editors = ['super_admin', 'manager', 'admin'];

r.get('/automations', ah(async (req, res) => {
  const { projects, managed, portfolioIds } = await visibleProjectDirectory(req.user);
  const groups = await AutomationGroup.find({ _id: { $in: projects.map((project) => project._id) } })
    .select('links').lean();
  const byProject = new Map(groups.map((group) => [String(group._id), group.links]));
  res.json(projects.map((project) => ({
    id: project._id,
    name: project.name,
    links: byProject.get(String(project._id)) ?? null,
    canEdit: editors.includes(req.user.role) && (managed === null || managed.includes(String(project.client)) ||
      isAssignedProjectManager(req.user, project) ||
      (req.user.role === 'manager' && portfolioIds.has(String(project._id)))),
  })));
}));

async function manageableProject(req) {
  if (!editors.includes(req.user.role)) throw new HttpError(403, 'Project management access is required');
  const { projectId } = req.params;
  if (!isObjectIdOrHexString(projectId)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.findOne({ _id: projectId, deletedAt: null }).select('client projectManager').lean();
  if (!project) throw new HttpError(404, 'Project not found');
  if (!await canManageProject(req.user, project)) throw new HttpError(403, 'Project management access is required');
  return project;
}

r.put('/automations/:projectId', ah(async (req, res) => {
  const project = await manageableProject(req);
  await AutomationGroup.updateOne({ _id: project._id }, { $setOnInsert: { links: [] } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });
  res.json({ ok: true });
}));

r.post('/automations/:projectId/links', ah(async (req, res) => {
  const project = await manageableProject(req);
  const { name, url } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new HttpError(400, 'Enter a tool name up to 120 characters');
  let link;
  try {
    if (typeof url !== 'string' || url.trim().length > 2048) throw new Error();
    link = new URL(url.trim());
    if (link.protocol !== 'https:' || link.username || link.password || link.href.length > 2048) throw new Error();
  } catch {
    throw new HttpError(400, 'Enter a valid HTTPS link');
  }
  const card = { name: name.trim(), url: link.href };
  const result = await AutomationGroup.updateOne({ _id: project._id, 'links.url': { $ne: card.url } },
    { $push: { links: card } }, { runValidators: true });
  if (!result.modifiedCount) {
    if (!await AutomationGroup.exists({ _id: project._id })) throw new HttpError(404, 'Add this project to Automations first');
    throw new HttpError(409, 'This link is already on the project dashboard');
  }
  res.status(201).json(card);
}));

export default r;

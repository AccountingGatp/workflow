import { Router } from 'express';
import mongoose from 'mongoose';
import { Client, ClientAssignment, ClientPermission, ClientProject, ProjectPermission, Task, TaskTemplate, TeamMembership, User } from '../models/index.js';
import { allProjectsEnabled, setAllProjectsEnabled } from '../services/project-access-settings.js';
import { ah, HttpError, requireRole } from '../middleware/auth.js';
import { canSeeClient, canSeeProject, canManageClient, canManageProject, taskPortfolio, taskScope, canGrantDirectly, clientAssignees, grantedProjectIds, visibleClientIds, activePermissionFilter, audit } from '../services/access.js';

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
async function findProject(clientId, id) {
  if (!valid(clientId) || !valid(id)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.findOne({ _id: id, client: clientId, deletedAt: null }).lean();
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}

r.get('/settings/project-access', requireRole('super_admin'), ah(async (_req, res) => {
  res.json({ enabled: await allProjectsEnabled() });
}));

r.put('/settings/project-access', requireRole('super_admin'), ah(async (req, res) => {
  res.json({ enabled: await setAllProjectsEnabled(req.body?.enabled) });
}));

r.get('/users/:id/projects', requireRole('super_admin'), ah(async (req, res) => {
  const person = valid(req.params.id) && await User.findOne({ _id: req.params.id, active: true, deletedAt: null }).select('role');
  if (!person) throw new HttpError(404, 'Active person not found');
  const [clients, granted, visible] = await Promise.all([
    Client.find({ status: { $ne: 'inactive' } }).select('name standaloneProject').lean(),
    grantedProjectIds(person, { includeDefault: false }),
    visibleClientIds(person),
  ]);
  const names = new Map(clients.filter((client) => !client.standaloneProject).map((client) => [String(client._id), client.name]));
  const assigned = new Set(granted.map(String));
  const projects = await ClientProject.find({ client: { $in: clients.map((client) => client._id) }, deletedAt: null })
    .select('name client referenceClient').sort({ name: 1, _id: 1 }).lean();
  res.json(projects.map(({ referenceClient, ...project }) => ({
    ...project, clientName: names.get(String(referenceClient || project.client)),
    assigned: visible === null || visible.includes(String(project.client)) || assigned.has(String(project._id)),
  })));
}));

r.get('/clients/:clientId/projects/:id/people', ah(async (req, res) => {
  const { clientId, id } = req.params;
  await check(req, clientId, true);
  const project = await findProject(clientId, id);
  const [people, grants, direct, managers] = await Promise.all([
    clientAssignees(req.user, clientId, project._id),
    ProjectPermission.distinct('user', { project: project._id }),
    ClientPermission.distinct('user', { client: clientId, ...activePermissionFilter() }),
    ClientAssignment.find({ client: clientId, endedAt: null }).select('team admin').lean(),
  ]);
  const leads = await TeamMembership.distinct('user', { team: { $in: managers.map((row) => row.team).filter(Boolean) }, teamRole: 'lead', removedAt: null });
  const assigned = new Set([...grants, ...direct].map(String));
  const managed = new Set([...leads, ...managers.map((row) => row.admin).filter(Boolean)].map(String));
  res.json(people.map((person) => ({ ...person,
    assigned: person.role === 'super_admin' || assigned.has(String(person._id)) ||
      (['admin', 'manager'].includes(person.role) && managed.has(String(person._id))),
  })));
}));

r.put('/clients/:clientId/projects/:id/people/:userId', ah(async (req, res) => {
  const { clientId, id, userId } = req.params;
  await check(req, clientId, true);
  const project = await findProject(clientId, id);
  if (!(await Client.exists({ _id: clientId, status: { $ne: 'inactive' } }))) throw new HttpError(400, 'This project is inactive');
  const person = valid(userId) && await User.findOne({ _id: userId, active: true, deletedAt: null }).select('name role');
  if (!person) throw new HttpError(404, 'Active person not found');
  if (await canSeeProject(person, project, { includeDefault: false })) return res.json({ ok: true });
  if (!(await canGrantDirectly(req.user, clientId, userId))) throw new HttpError(403, 'A Super Admin can assign this project to people outside your team');
  const filter = { project: project._id, user: person._id };
  try {
    const result = await ProjectPermission.updateOne(filter, { $setOnInsert: { grantedBy: req.user._id } }, { upsert: true });
    if (result.upsertedCount) await audit(req.user, 'access.grant', {
      entity: 'ProjectPermission', entityId: result.upsertedId, client: clientId,
      summary: `Gave ${person.name} access to ${project.name}`,
    });
  } catch (error) {
    if (error.code !== 11000 || !(await ProjectPermission.exists(filter))) throw error;
  }
  res.json({ ok: true });
}));

r.get('/projects', ah(async (req, res) => {
  const [ids, granted] = await Promise.all([visibleClientIds(req.user), grantedProjectIds(req.user)]);
  const { clients: managed, projects: portfolio } = await taskPortfolio(req.user, granted);
  const portfolioIds = new Set(portfolio.map(String));
  const clients = await Client.find(ids === null ? {} : { _id: { $in: ids } }).select('name standaloneProject').lean();
  const clientInfo = new Map(clients.map((client) => [String(client._id), client]));
  const clientIds = clients.map(({ _id }) => _id);
  const projects = await ClientProject.find(ids === null ? { deletedAt: null } : {
    deletedAt: null, $or: [{ client: { $in: clientIds } }, { _id: { $in: [...granted, ...portfolio] } }],
  }).select('name client referenceClient').sort({ name: 1, _id: 1 }).lean();
  if (!projects.length) return res.json([]);
  const now = new Date();
  const scope = await taskScope(req.user);
  const counts = await Task.aggregate([
    { $match: { ...scope, project: { $in: projects.map(({ _id }) => _id) }, status: { $ne: 'done' } } },
    { $group: { _id: '$project', open: { $sum: 1 }, overdue: {
      $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$dueDate', null] }, null] }, { $lt: ['$dueDate', now] }] }, 1, 0] },
    } } },
  ]);
  const byProject = new Map(counts.map((row) => [String(row._id), row]));
  res.json(projects.map(({ referenceClient, ...project }) => {
    const tasks = byProject.get(String(project._id));
    const owner = clientInfo.get(String(project.client));
    const reference = owner?.standaloneProject ? clientInfo.get(String(referenceClient)) : owner;
    return {
      ...project,
      clientName: reference?.name,
      canManage: req.user.role !== 'hr' && (managed === null || managed.includes(String(project.client)) ||
        (req.user.role === 'manager' && portfolioIds.has(String(project._id)))),
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
  const { clientId } = req.params;
  if (!valid(clientId)) throw new HttpError(404, 'Client not found');
  const seesClient = await canSeeClient(req.user, clientId);
  const grants = seesClient || req.user.role === 'admin' ? null : await grantedProjectIds(req.user);
  const projects = await ClientProject.find({ client: clientId, deletedAt: null, ...(grants && { _id: { $in: grants } }) }).sort({ name: 1 }).lean();
  if (!seesClient && !projects.length) throw new HttpError(403, 'Client access denied');
  const manager = await canManageClient(req.user, clientId);
  res.json(projects.map(p => safeProject(p, manager || req.user.role === 'manager')));
}));
r.get('/clients/:clientId/projects/:id', ah(async (req, res) => {
  const { clientId, id } = req.params;
  const project = await findProject(clientId, id);
  if (req.user.role !== 'admin' && !(await canSeeProject(req.user, project))) throw new HttpError(403, 'Project access denied');
  const [manager, clientManager, clientReference, clientVisible, client] = await Promise.all([
    canManageProject(req.user, project),
    canManageClient(req.user, clientId),
    visibleReference(req.user, project.referenceClient),
    canSeeClient(req.user, clientId),
    Client.findById(clientId).select('name standaloneProject').lean(),
  ]);
  if (!client) throw new HttpError(404, 'Project not found');
  res.json({ ...safeProject(project, manager), clientReference, workspace: {
    name: client.name, standaloneProject: !!client.standaloneProject, canManage: manager, canManageClient: clientManager, canEditTasks: manager || req.user.role === 'admin', canSeeClient: clientVisible,
  } });
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
  const project = await ClientProject.findOneAndUpdate({ _id: id, client: clientId, deletedAt: null }, update);
  if (!project) throw new HttpError(404, 'Project not found');
  audit(req.user, 'project.update', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Updated client information for ' + project.name });
  res.json({ clientReference });
}));

r.patch('/clients/:clientId/projects/:id', ah(async (req, res) => {
  const existing = await findProject(req.params.clientId, req.params.id);
  if (!await canManageProject(req.user, existing)) throw new HttpError(403, 'Project management access denied');
  const keys = ['name', 'description', 'businessType', 'website', 'contacts', 'team', 'scope', 'excluded', 'links', 'tools', 'automations', 'quality', 'guarantees', 'notes'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => keys.includes(k)));
  if (update.name !== undefined && !String(update.name).trim()) throw new HttpError(400, 'Name required');
  for (const key of ['contacts','team','scope','excluded','links','tools','automations','quality','guarantees']) {
    if (key in update && !Array.isArray(update[key])) throw new HttpError(400, key + ' must be a list');
  }
  const project = await ClientProject.findOneAndUpdate({ _id: req.params.id, client: req.params.clientId, deletedAt: null }, { $set: update }, { new: true, runValidators: true });
  if (!project) throw new HttpError(404, 'Project not found');
  audit(req.user, 'project.update', { entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Updated project ' + project.name });
  res.json(safeProject(project.toObject(), true));
}));
r.delete('/clients/:clientId/projects/:id', requireRole('super_admin'), ah(async (req, res) => {
  const { clientId, id } = req.params;
  await check(req, clientId, true);
  if (!valid(id)) throw new HttpError(404, 'Project not found');
  const project = await ClientProject.db.transaction(async (session) => {
    const removed = await ClientProject.findOneAndUpdate(
      { _id: id, client: clientId, deletedAt: null }, { $set: { deletedAt: new Date() } }, { session },
    );
    if (!removed) {
      if (await ClientProject.exists({ _id: id, client: clientId, deletedAt: { $ne: null } }).session(session)) return null;
      throw new HttpError(404, 'Project not found');
    }
    await ProjectPermission.deleteMany({ project: id }).session(session);
    await TaskTemplate.updateMany({ project: id, active: true }, { $set: { active: false } }, { session });
    return removed;
  });
  if (project) audit(req.user, 'project.delete', {
    entity: 'ClientProject', entityId: project._id, client: project.client, summary: 'Deleted project ' + project.name,
  });
  res.json({ ok: true });
}));
export default r;

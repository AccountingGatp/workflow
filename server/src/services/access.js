import { Types } from 'mongoose';
import { Client, ClientAssignment, ClientPermission, ClientProject, ProjectPermission, TeamMembership, User, AuditLog } from '../models/index.js';
import { allProjectsEnabled } from './project-access-settings.js';
import { HttpError } from '../middleware/auth.js';

/**
 * Central access rules. Every route asks this module; nothing else decides visibility.
 *
 *  super_admin  -> everything
 *  manager/admin -> clients they are assigned to manage (+ any explicit permission)
 *  hr           -> workspace-wide work monitoring with read-only access
 *  employee     -> only clients with an active explicit ClientPermission
 *
 * Team membership alone never grants client access.
 */

export const isSuper = (u) => u.role === 'super_admin';
export const superAdminIds = () => User.distinct('_id', { role: 'super_admin' });
export const staffTaskFilter = (adminIds) => ({
  dailyWorkCustom: { $ne: true },
  $or: [
    { assignees: { $exists: false } },
    { assignees: { $size: 0 } },
    { assignees: { $elemMatch: { $nin: adminIds } } },
  ],
});

export const canMonitorAllWork = (user) => isSuper(user) || user.role === 'hr';
export const canMaintainTasks = (user) => isSuper(user) || user.role === 'manager';

export const activePermissionFilter = () => ({
  revokedAt: null,
  $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
});

/**
 * Client ids this admin manages: clients of the team(s) they lead (each team has one TL),
 * plus any client they were added to directly as an extra manager.
 */
export async function managedClientIds(user) {
  if (isSuper(user)) return null; // null = unrestricted
  if (!['admin', 'manager'].includes(user.role)) return [];
  const led = await ledTeamIds(user);
  const rows = await ClientAssignment.find({ endedAt: null, $or: [{ admin: user._id }, { team: { $in: led } }] }).select('client');
  return [...new Set(rows.map((r) => String(r.client)))];
}

/** The TL of each team, keyed by team id. */
export async function teamLeads(teamIds) {
  const rows = await TeamMembership.find({ team: { $in: teamIds }, teamRole: 'lead', removedAt: null }).populate('user', 'name email');
  return Object.fromEntries(rows.filter((r) => r.user).map((r) => [String(r.team), r.user]));
}

/** Client ids the user may see. null means "all". */
export async function visibleClientIds(user) {
  if (canMonitorAllWork(user)) return null;
  const perms = await ClientPermission.find({ user: user._id, ...activePermissionFilter() }).select('client');
  const ids = new Set(perms.map((p) => String(p.client)));
  for (const id of (await managedClientIds(user)) || []) ids.add(id);
  return [...ids];
}

/** Active grants that apply only to their own project. */
export async function grantedProjectIds(user, { includeDefault = true } = {}) {
  if (canMonitorAllWork(user)) return [];
  const ids = await ProjectPermission.distinct('project', { user: user._id });
  if (includeDefault && await allProjectsEnabled(user)) {
    const active = await activeProjectIds();
    const direct = ids.length ? await ClientProject.distinct('_id', { _id: { $in: ids }, deletedAt: null }) : [];
    return [...new Map([...active, ...direct].map((id) => [String(id), id])).values()];
  }
  return ids.length ? ClientProject.distinct('_id', { _id: { $in: ids }, deletedAt: null }) : [];
}

async function activeProjectIds() {
  const clients = await Client.distinct('_id', { status: { $ne: 'inactive' } });
  return ClientProject.distinct('_id', { client: { $in: clients }, deletedAt: null });
}

export async function canSeeProject(user, project, { includeDefault = true } = {}) {
  if (await canSeeClient(user, project.client) ||
      await ProjectPermission.exists({ project: project._id, user: user._id })) return true;
  return includeDefault && !project.deletedAt && await allProjectsEnabled(user) &&
    !!await Client.exists({ _id: project.client, status: { $ne: 'inactive' } });
}

export async function taskPortfolio(user, grants) {
  if (canMonitorAllWork(user)) return { clients: null, projects: [] };
  const clients = await managedClientIds(user);
  const projects = user.role === 'admin' ? await ClientProject.distinct('_id', { deletedAt: null }) :
    user.role === 'manager' ? [...new Set([
      ...(grants ?? await grantedProjectIds(user)).map(String),
      ...(await ClientProject.distinct('_id', { client: { $in: await visibleClientIds(user) }, deletedAt: null })).map(String),
    ])] : [];
  return { clients, projects };
}

const objectIds = (ids) => ids.map((id) => new Types.ObjectId(String(id)));

export function portfolioFilter({ clients, projects }) {
  return clients === null ? {} : { $or: [{ client: { $in: objectIds(clients) } }, { project: { $in: objectIds(projects) } }] };
}

export async function canManageProject(user, project) {
  return await canManageClient(user, project.client) ||
    (user.role === 'manager' && !project.deletedAt && await canSeeProject(user, project));
}

export async function canEditProjectWork(user, project) {
  return user.role === 'admin' || await canManageProject(user, project);
}

export async function canEditTaskInProject(user, clientId, projectId) {
  if (await canManageClient(user, clientId)) return true;
  if (!projectId || !['admin', 'manager'].includes(user.role)) return false;
  const project = await ClientProject.findOne({ _id: projectId, client: clientId, deletedAt: null }).select('client').lean();
  return !!project && await canEditProjectWork(user, project);
}

export async function canSeeClient(user, clientId) {
  const ids = await visibleClientIds(user);
  return ids === null || ids.includes(String(clientId));
}

export async function canManageClient(user, clientId) {
  const ids = await managedClientIds(user);
  return ids === null || ids.includes(String(clientId));
}

/** Teams where the user is lead (super admin: all). */
export async function ledTeamIds(user) {
  if (isSuper(user)) return null;
  if (user.role === 'hr') return [];
  const rows = await TeamMembership.find({ user: user._id, teamRole: 'lead', removedAt: null }).select('team');
  return rows.map((r) => String(r.team));
}

export async function userTeamIds(userId) {
  const rows = await TeamMembership.find({ user: userId, removedAt: null }).select('team');
  return rows.map((r) => String(r.team));
}

/**
 * Can `actor` grant client access to `targetUserId` directly?
 * Super admin: yes. Admin: only for clients they manage AND people in a team they lead.
 * Otherwise it must go through an AccessRequest for super admin approval.
 */
export async function canGrantDirectly(actor, clientId, targetUserId) {
  if (isSuper(actor)) return true;
  if (!(await canManageClient(actor, clientId))) return false;
  const led = await ledTeamIds(actor);
  const theirs = await userTeamIds(targetUserId);
  return theirs.some((t) => led.includes(t));
}

/** People the actor can assign to this client, including team members who get access on assignment. */
export async function clientAssignees(actor, clientId, projectId, { existingAccessOnly = false } = {}) {
  const filter = { active: true, deletedAt: null, role: { $ne: 'super_admin' } };
  if (!isSuper(actor) && !(projectId && await allProjectsEnabled(actor) &&
      await Client.exists({ _id: clientId, status: { $ne: 'inactive' } }))) {
    const [assignments, grants, led, projectGrants] = await Promise.all([
      ClientAssignment.find({ client: clientId, endedAt: null }).select('team admin').lean(),
      ClientPermission.distinct('user', { client: clientId, ...activePermissionFilter() }),
      existingAccessOnly ? [] : ledTeamIds(actor),
      projectId ? ProjectPermission.distinct('user', { project: projectId }) : [],
    ]);
    const teams = assignments.map((row) => row.team).filter(Boolean);
    const memberships = await TeamMembership.distinct('user', { removedAt: null, $or: [
      { team: { $in: led } },
      { team: { $in: teams }, teamRole: 'lead' },
    ] });
    filter.$or = [
      { _id: { $in: [...grants, ...memberships, ...projectGrants] } },
      { _id: { $in: assignments.map((row) => row.admin).filter(Boolean) }, role: { $in: ['manager', 'admin'] } },
    ];
  }
  return User.find(filter).select('name email role').sort('name').lean();
}

export async function ensureAssigneeAccess(actor, clientId, person, projectId) {
  if (isSuper(person)) throw new HttpError(400, 'Super Admins cannot be assigned work');
  if (projectId ? await canSeeProject(person, { _id: projectId, client: clientId }) : await canSeeClient(person, clientId)) return;
  if (!(await canGrantDirectly(actor, clientId, person._id))) {
    throw new HttpError(400, `${person.name} is outside your team and needs access to this client before you can assign work.`);
  }
  const permission = await ClientPermission.create({ client: clientId, user: person._id, grantedBy: actor._id });
  const client = await Client.findById(clientId).select('name');
  audit(actor, 'access.grant', { entity: 'ClientPermission', entityId: permission._id, client: clientId,
    summary: `Gave ${person.name} access to ${client?.name} (assigned work)` });
}

/** Mongo filter for tasks the user can see. */
export async function taskScope(user) {
  if (canMonitorAllWork(user)) return { deletedAt: null };
  const [visible, grants] = await Promise.all([visibleClientIds(user), grantedProjectIds(user)]);
  const { clients, projects } = await taskPortfolio(user, grants);
  return {
    deletedAt: null,
    $or: [
      ...portfolioFilter({ clients, projects }).$or,
      { assignees: user._id, $or: [{ client: { $in: objectIds(visible) } }, { project: { $in: objectIds(grants) } }] },
    ],
  };
}

export function audit(actor, action, { entity, entityId, client, project, summary } = {}) {
  return AuditLog.create({ actor: actor?._id, action, entity, entityId, client, project, summary }).catch(() => {});
}

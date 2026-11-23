import { Client, ClientAssignment, ClientPermission, ClientProject, ProjectPermission, TeamMembership, User, Task, AuditLog } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';

/**
 * Central access rules. Every route asks this module; nothing else decides visibility.
 *
 *  super_admin  -> everything
 *  manager/admin -> clients they are assigned to manage (+ any explicit permission)
 *  employee     -> only clients with an active explicit ClientPermission
 *
 * Team membership alone never grants client access.
 */

export const isSuper = (u) => u.role === 'super_admin';
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
  if (isSuper(user)) return null;
  const perms = await ClientPermission.find({ user: user._id, ...activePermissionFilter() }).select('client');
  const ids = new Set(perms.map((p) => String(p.client)));
  for (const id of (await managedClientIds(user)) || []) ids.add(id);
  return [...ids];
}

/** Active grants that apply only to their own project. */
export async function grantedProjectIds(user) {
  if (isSuper(user)) return [];
  const ids = await ProjectPermission.distinct('project', { user: user._id });
  return ids.length ? ClientProject.distinct('_id', { _id: { $in: ids }, deletedAt: null }) : [];
}

export async function canSeeProject(user, project) {
  return await canSeeClient(user, project.client) ||
    !!await ProjectPermission.exists({ project: project._id, user: user._id });
}

export async function canEditProjectWork(user, project) {
  if (await canManageClient(user, project.client)) return true;
  if (user.role !== 'admin') return false;
  if (await ProjectPermission.exists({ project: project._id, user: user._id })) return true;
  if (!await canSeeClient(user, project.client)) return false;
  return !!await Task.exists({
    project: project._id, client: project.client, assignees: user._id, deletedAt: null,
    status: { $nin: ['cancelled', 'done'] },
    // A lead's own Daily Work entries must not grant editing access.
    dailyWorkCustom: { $exists: false }, createdBy: { $ne: user._id },
  });
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
  const filter = { active: true, deletedAt: null };
  if (!isSuper(actor)) {
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
      { role: 'super_admin' },
    ];
  }
  return User.find(filter).select('name email role').sort('name').lean();
}

export async function ensureAssigneeAccess(actor, clientId, person, projectId) {
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
  if (isSuper(user)) return { deletedAt: null };
  const [managed, visible, projects] = await Promise.all([managedClientIds(user), visibleClientIds(user), grantedProjectIds(user)]);
  // Admins see every task on clients they manage; anyone sees their own assigned tasks
  // provided they still have access to that client.
  return {
    deletedAt: null,
    $or: [
      { client: { $in: managed } },
      { assignees: user._id, $or: [{ client: { $in: visible } }, { project: { $in: projects } }] },
    ],
  };
}

export function audit(actor, action, { entity, entityId, client, summary } = {}) {
  return AuditLog.create({ actor: actor?._id, action, entity, entityId, client, summary }).catch(() => {});
}

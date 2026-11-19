import { User, TeamMembership, Client, ClientProject } from '../models/index.js';
import { HttpError } from '../middleware/auth.js';
import { isSuper, ledTeamIds, managedClientIds, visibleClientIds } from '../services/access.js';

export async function dailyScope(user) {
  const own = String(user._id);
  if (isSuper(user)) return { own, managed: null, visible: null, members: null };
  const [managed, visible, teams] = await Promise.all([managedClientIds(user), visibleClientIds(user), ledTeamIds(user)]);
  const teamMembers = teams.length
    ? await TeamMembership.distinct('user', { team: { $in: teams }, removedAt: null })
    : [];
  return { own, managed, visible, members: [...new Set([own, ...teamMembers.map(String)])] };
}

export const includes = (scope, id) => scope === null || scope.includes(String(id));

export async function roster(scope, models, inactive = false) {
  const filter = inactive ? {} : { active: true };
  if (scope.members !== null) filter._id = { $in: scope.members };
  const users = await User.find(filter).select('name active').sort('name').lean();
  const settings = await models.Member.find({ _id: { $in: users.map((user) => String(user._id)) } }).lean();
  const byId = new Map(settings.map((member) => [member._id, member]));
  return users.map(({ _id, ...user }) => {
    const settings = byId.get(String(_id));
    return { ...user, id: String(_id), enrolled: false, shift: 'morning', ...settings };
  });
}

export async function workflowProjects(scope) {
  const filter = scope.managed === null ? {} : { _id: { $in: scope.managed } };
  const clients = await Client.find(filter).select('name').sort('name').lean();
  const projects = await ClientProject.find({ client: { $in: clients.map((client) => client._id) } }).select('client name').sort('name').lean();
  return { clients, projects };
}

export async function validateProjectLink(scope, clientId, workflowProjectId) {
  if (!includes(scope.managed, clientId)) throw new HttpError(403, 'You do not manage that client');
  if (!(await Client.exists({ _id: clientId }))) throw new HttpError(404, 'Workflow client not found');
  if (workflowProjectId && !(await ClientProject.exists({ _id: workflowProjectId, client: clientId }))) {
    throw new HttpError(400, 'Select a Workflow project belonging to this client');
  }
}

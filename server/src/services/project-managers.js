import { ClientProject, User } from '../models/index.js';

export const projectManagerRoles = ['manager', 'admin', 'super_admin'];
export const managerAccountFilter = { active: true, deletedAt: null, role: { $in: projectManagerRoles } };

export function managerRecord(account) {
  return { name: account.name, user: account._id, accountVerified: true };
}

export function isAssignedProjectManager(user, project) {
  return projectManagerRoles.includes(user.role) && !project.deletedAt &&
    project.projectManager?.accountVerified === true && String(project.projectManager.user) === String(user._id);
}

export function assignedManagerProjectIds(user) {
  if (!['manager', 'admin'].includes(user.role)) return [];
  return ClientProject.distinct('_id', {
    'projectManager.user': user._id, 'projectManager.accountVerified': true, deletedAt: null,
  });
}

export async function linkRosterManagers(emailByName) {
  const accounts = await User.find({
    ...managerAccountFilter, email: { $in: Object.values(emailByName) },
  }).select('name email').lean();
  const byEmail = new Map(accounts.map((account) => [account.email, account]));
  const entries = Object.entries(emailByName).filter(([, email]) => byEmail.has(email));
  if (!entries.length) return 0;
  const result = await ClientProject.bulkWrite(entries.map(([name, email]) => ({
    updateMany: {
      filter: { 'projectManager.name': name, 'projectManager.accountVerified': { $ne: true }, deletedAt: null },
      update: { $set: { projectManager: managerRecord(byEmail.get(email)) } },
    },
  })), { timestamps: false });
  return result.modifiedCount;
}

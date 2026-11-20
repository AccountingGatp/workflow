import { Router } from 'express';
import { AuthSession, User, Team, TeamMembership, ClientPermission, ClientAssignment, slackUserIdPattern, userRoles } from '../models/index.js';
import { ah, requireRole, HttpError } from '../middleware/auth.js';
import { audit, isSuper, ledTeamIds } from '../services/access.js';

import { dailyModels } from '../daily-work/models.js';
import { clock } from '../daily-work/dates.js';
import { leaveDates, setCurrentLeave } from '../daily-work/leave.js';
import { dailyReportSettings, parseDailyReport } from '../daily-work/settings.js';
import { loginEmail } from '../services/email-login.js';

import { SignInRequest } from '../services/sign-in-requests.js';

const r = Router();

/* ---------- Users ---------- */

function parseSlackUserId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid Slack user ID');
  const id = value.trim().toUpperCase();
  if (id && !slackUserIdPattern.test(id)) throw new HttpError(400, 'Enter a Slack user ID, such as U012ABC3456');
  return id || null;
}

r.get('/sign-in-requests', requireRole('super_admin'), ah(async (_req, res) => {
  const [pending, history] = await Promise.all([
    SignInRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean(),
    SignInRequest.find({ status: { $ne: 'pending' } }).sort({ decidedAt: -1 }).limit(50).lean(),
  ]);
  res.json({ pending, history });
}));

r.post('/sign-in-requests/:email/:decision', requireRole('super_admin'), ah(async (req, res) => {
  const approve = req.params.decision === 'approve';
  if (!approve && req.params.decision !== 'reject') throw new HttpError(404, 'Unknown action');
  const email = loginEmail(req.params.email);
  const status = approve ? 'approved' : 'rejected';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (approve && (name.length > 150 || title.length > 150)) throw new HttpError(400, 'Use up to 150 characters for name and job title');
  const slackUserId = approve ? parseSlackUserId(req.body?.slackUserId) : undefined;
  const request = await User.db.transaction(async (session) => {
    const pending = await SignInRequest.findOneAndUpdate({ _id: email, status: 'pending' }, {
      $set: { status, decidedBy: req.user._id, decidedAt: new Date() },
    }, { session, returnDocument: 'after' });
    if (!pending) throw new HttpError(409, 'This request has already been reviewed or no longer exists');
    if (approve) {
      await User.create([{ email, name: name || pending.name, title, slackUserId, role: 'employee' }], { session });
    }
    return pending;
  });
  audit(req.user, `sign-in-request.${status}`, {
    entity: 'User', summary: `${approve ? 'Approved' : 'Rejected'} sign-in request for ${email}`,
  });
  res.json(request);
}));

r.get('/users', ah(async (req, res) => {
  // Everyone signed in may look up colleagues by name (needed for assigning work);
  // memberships are attached so the UI can show which teams each person is in.
  const includeReport = isSuper(req.user) && req.query.dailyReport === '1';
  const users = await User.find({ deletedAt: null })
    .select(includeReport ? '+slackUserId +dailyReport' : isSuper(req.user) ? '+slackUserId' : '').sort({ name: 1 }).lean();
  const memberships = await TeamMembership.find({ removedAt: null }).populate('team', 'name color').lean();
  const byUser = {};
  for (const m of memberships) (byUser[m.user] ||= []).push({ team: m.team, teamRole: m.teamRole });
  if (includeReport) {
    const legacyIds = users.filter((user) => !user.dailyReport).map((user) => String(user._id));
    const { Member, Leave } = await dailyModels();
    const { date } = clock();
    const [legacy, leave] = await Promise.all([
      legacyIds.length ? Member.find({ _id: { $in: legacyIds } }).lean() : [],
      leaveDates(Leave, date),
    ]);
    const legacyById = new Map(legacy.map((member) => [member._id, member]));
    for (const user of users) {
      user.dailyReport = dailyReportSettings(user.dailyReport, legacyById.get(String(user._id)));
      user.onLeave = leave.has(`${user._id}:${date}`);
    }
  }
  res.json(users.map((u) => ({ ...u, teams: byUser[u._id] || [] })));
}));

r.post('/users', requireRole('super_admin'), ah(async (req, res) => {
  const { name, email: address, role = 'employee', title, slackUserId, dailyReport } = req.body || {};
  const email = loginEmail(address);
  if (!name) throw new HttpError(400, 'Name is required');
  if (!userRoles.includes(role)) throw new HttpError(400, 'Invalid role');
  if (await User.exists({ email })) throw new HttpError(409, 'That email is already in use');
  const user = await User.create({ name, email, role, title, slackUserId: parseSlackUserId(slackUserId), dailyReport: dailyReport === undefined ? undefined : parseDailyReport(dailyReport) });
  audit(req.user, 'user.create', { entity: 'User', entityId: user._id, summary: `Created ${role.replace('_', ' ')} ${name}` });
  res.status(201).json(user);
}));

r.put('/users/:id/leave', requireRole('super_admin'), ah(async (req, res) => {
  const { onLeave } = req.body || {};
  if (typeof onLeave !== 'boolean') throw new HttpError(400, 'Choose Active or On leave');
  const person = await User.findOne({ _id: req.params.id, active: true, deletedAt: null }).select('_id');
  if (!person) throw new HttpError(404, 'Active person not found');
  const { Leave } = await dailyModels();
  await setCurrentLeave(Leave, String(person._id), clock().date, onLeave);
  res.json({ onLeave });
}));

r.patch('/users/:id', requireRole('super_admin'), ah(async (req, res) => {
  const allowed = ['name', 'email', 'role', 'title', 'active', 'slackUserId', 'dailyReport'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const user = await User.findOne({ _id: req.params.id, deletedAt: null }).select('+slackUserId +dailyReport');
  if (!user) throw new HttpError(404, 'User not found');
  if (String(user._id) === String(req.user._id) && (update.role && update.role !== 'super_admin' || update.active === false)) {
    throw new HttpError(400, 'You cannot demote or deactivate yourself');
  }
  if (update.name !== undefined) {
    update.name = String(update.name).trim();
    if (!update.name || update.name.length > 150) throw new HttpError(400, 'Enter a valid name (1–150 characters)');
  }
  if (update.title !== undefined) update.title = String(update.title).trim().slice(0, 150);
  if (update.email !== undefined) {
    update.email = loginEmail(update.email);
    if (update.email !== user.email && await User.exists({ email: update.email, _id: { $ne: user._id } })) {
      throw new HttpError(409, 'That email address is already used by another person');
    }
  }
  if (update.role !== undefined && !userRoles.includes(update.role)) throw new HttpError(400, 'Invalid role');
  if (update.slackUserId !== undefined) update.slackUserId = parseSlackUserId(update.slackUserId);
  if (update.dailyReport !== undefined) update.dailyReport = parseDailyReport(update.dailyReport);
  const previous = { name: user.name, email: user.email, role: user.role, title: user.title || '',
    active: user.active, slackUserId: user.slackUserId || null, dailyReport: user.dailyReport?.toObject() };
  if (update.email !== undefined && update.email !== user.email) {
    user.googleSubject = undefined;
    user.markModified('googleSubject');
  }
  Object.assign(user, update);
  try { await user.save(); } catch (err) {
    if (err.code === 11000) throw new HttpError(409, 'That email address is already used by another person');
    throw err;
  }
  const changed = allowed.filter(k => update[k] !== undefined && JSON.stringify(previous[k]) !== JSON.stringify(update[k]));
  if (changed.includes('email') || update.active === false) await AuthSession.deleteMany({ user: user._id });
  audit(req.user, 'user.update', { entity: 'User', entityId: user._id, summary: `Updated ${user.name}: ${changed.join(', ') || 'no changes'}` });
  res.json(user);
}));

/**
 * Remove a person. Their account is closed and they lose every team and client access,
 * but their name stays on past tasks and in the activity log.
 */
r.delete('/users/:id', requireRole('super_admin'), ah(async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) throw new HttpError(400, 'You cannot remove yourself');
  const user = await User.findOne({ _id: req.params.id, deletedAt: null });
  if (!user) throw new HttpError(404, 'User not found');
  const leads = await TeamMembership.find({ user: user._id, teamRole: 'lead', removedAt: null }).populate('team', 'name archived');
  const ledActive = leads.filter((l) => l.team && !l.team.archived);
  if (ledActive.length) throw new HttpError(400, `${user.name} is TL of ${ledActive.map((l) => l.team.name).join(', ')}. Choose a new TL first.`);
  const now = new Date();
  await TeamMembership.updateMany({ user: user._id, removedAt: null }, { removedAt: now });
  await ClientPermission.updateMany({ user: user._id, revokedAt: null }, { revokedAt: now, revokedBy: req.user._id });
  await ClientAssignment.updateMany({ admin: user._id, endedAt: null }, { endedAt: now });
  user.active = false; user.deletedAt = now;
  user.email = `removed-${user._id}-${user.email}`; // frees the email so it can be used again
  await user.save();
  await AuthSession.deleteMany({ user: user._id });
  audit(req.user, 'user.remove', { entity: 'User', entityId: user._id, summary: `Removed ${user.name}` });
  res.json({ ok: true });
}));

/* ---------- Teams ---------- */

r.get('/teams', ah(async (req, res) => {
  const teams = await Team.find({ archived: false }).sort({ name: 1 }).lean();
  const memberships = await TeamMembership.find({ removedAt: null }).populate('user', 'name email role title').lean();
  const led = await ledTeamIds(req.user);
  res.json(teams.map((t) => ({
    ...t,
    members: memberships.filter((m) => String(m.team) === String(t._id)).map((m) => ({ ...m.user, teamRole: m.teamRole })),
    canManage: led === null || led.includes(String(t._id)),
  })));
}));

/** Each team has exactly one TL. Setting a new one turns the previous TL into a member. */
async function setTeamLead(teamId, leadId) {
  const lead = await User.findById(leadId);
  if (!lead || lead.role !== 'admin') throw new HttpError(400, 'The team lead must be a person with the Admin / TL role');
  await TeamMembership.updateMany({ team: teamId, teamRole: 'lead', user: { $ne: lead._id } }, { teamRole: 'member' });
  await TeamMembership.findOneAndUpdate({ team: teamId, user: lead._id }, { teamRole: 'lead', removedAt: null }, { upsert: true });
  return lead;
}

r.post('/teams', requireRole('super_admin'), ah(async (req, res) => {
  const { name, description, color, leadId } = req.body || {};
  if (!name) throw new HttpError(400, 'Team name is required');
  if (!leadId) throw new HttpError(400, 'Choose the TL / manager for this team');
  if (await Team.exists({ name })) throw new HttpError(409, 'A team with that name already exists');
  const team = await Team.create({ name, description, color });
  const lead = await setTeamLead(team._id, leadId).catch(async (e) => { await team.deleteOne(); throw e; });
  audit(req.user, 'team.create', { entity: 'Team', entityId: team._id, summary: `Created team ${name} led by ${lead.name}` });
  res.status(201).json(team);
}));

r.patch('/teams/:id', requireRole('super_admin'), ah(async (req, res) => {
  const team = await Team.findById(req.params.id);
  if (!team) throw new HttpError(404, 'Team not found');
  const { name, description, color, leadId } = req.body || {};
  if (name) team.name = name;
  if (description !== undefined) team.description = description;
  if (color) team.color = color;
  await team.save();
  if (leadId) {
    const lead = await setTeamLead(team._id, leadId);
    audit(req.user, 'team.lead', { entity: 'Team', entityId: team._id, summary: `${lead.name} is now TL of ${team.name}` });
  }
  res.json(team);
}));

r.delete('/teams/:id', requireRole('super_admin'), ah(async (req, res) => {
  const team = await Team.findByIdAndUpdate(req.params.id, { archived: true }, { new: true });
  if (!team) throw new HttpError(404, 'Team not found');
  await TeamMembership.updateMany({ team: team._id, removedAt: null }, { removedAt: new Date() });
  audit(req.user, 'team.delete', { entity: 'Team', entityId: team._id, summary: `Deleted team ${team.name}` });
  res.json({ ok: true });
}));

async function assertCanManageTeam(user, teamId) {
  if (isSuper(user)) return;
  const led = await ledTeamIds(user);
  if (!led.includes(String(teamId))) throw new HttpError(403, 'Only this team’s lead or a Super Admin can change members');
}

r.post('/teams/:id/members', ah(async (req, res) => {
  await assertCanManageTeam(req.user, req.params.id);
  const { userId } = req.body || {};
  const teamRole = 'member'; // the TL is set on the team itself
  const target = await User.findById(userId);
  if (!target || target.deletedAt) throw new HttpError(404, 'User not found');
  const m = await TeamMembership.findOneAndUpdate(
    { user: userId, team: req.params.id },
    { teamRole, removedAt: null },
    { upsert: true, new: true },
  );
  const team = await Team.findById(req.params.id);
  audit(req.user, 'team.member_add', { entity: 'Team', entityId: team._id, summary: `Added ${target.name} to ${team.name} as ${teamRole}` });
  res.status(201).json(m);
}));

r.delete('/teams/:id/members/:userId', ah(async (req, res) => {
  await assertCanManageTeam(req.user, req.params.id);
  const isLead = await TeamMembership.exists({ user: req.params.userId, team: req.params.id, teamRole: 'lead', removedAt: null });
  if (isLead) throw new HttpError(400, 'This person is the team’s TL. Choose a new TL first.');
  // Soft removal: only this team is affected; client permissions are not touched.
  const m = await TeamMembership.findOneAndUpdate(
    { user: req.params.userId, team: req.params.id, removedAt: null },
    { removedAt: new Date() }, { new: true },
  ).populate('user', 'name').populate('team', 'name');
  if (!m) throw new HttpError(404, 'Membership not found');
  audit(req.user, 'team.member_remove', { entity: 'Team', entityId: m.team._id, summary: `Removed ${m.user.name} from ${m.team.name}` });
  res.json({ ok: true });
}));

export default r;

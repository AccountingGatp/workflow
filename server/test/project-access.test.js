import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { clock } from '../src/daily-work/dates.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import {
  AuditLog, Client, ClientAssignment, ClientPermission, ClientProject, ProjectPermission,
  ProjectWorkItem, Task, Team, TeamMembership, User,
} from '../src/models/index.js';

test('project assignment enables Daily Work without opening the rest of the client', async () => {
  const db = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
  });
  let server;
  try {
    await mongoose.connect(db.getUri());
    await ProjectPermission.init();
    handleErrors(app);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const createUser = (name, role) => User.create({
      name, role, email: `${name.toLowerCase().replaceAll(' ', '-')}@test.example`,
      active: true, passwordHash: 'fixture',
    });
    const [admin, lead, employee, coworker, manager] = await Promise.all([
      createUser('Test Owner', 'super_admin'), createUser('Test Lead', 'admin'),
      createUser('Test Employee', 'employee'), createUser('Test Coworker', 'employee'), createUser('Test Manager', 'manager'),
    ]);
    const client = await Client.create({ name: 'Fixture Client' });
    const [project, sibling] = await ClientProject.create([
      { name: 'First Project', client: client._id }, { name: 'Second Project', client: client._id },
    ]);
    const [item] = await ProjectWorkItem.create([
      { title: 'First Work Item', project: project._id, client: client._id, weeklyHours: '3 hours daily' },
      { title: 'Second Work Item', project: sibling._id, client: client._id },
    ]);
    const team = await Team.create({ name: 'Fixture Team' });
    await TeamMembership.create([
      { user: lead._id, team: team._id, teamRole: 'lead' }, { user: coworker._id, team: team._id },
    ]);
    await ClientAssignment.create({ client: client._id, team: team._id });

    async function request(user, path, method = 'GET', body, status = 200) {
      const response = await fetch(base + path, {
        method, headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + jwt.sign({ sub: String(user._id) }, JWT_SECRET),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }

    const clientPath = `/clients/${client._id}`;
    const projectPath = `${clientPath}/projects/${project._id}`;
    const siblingPath = `${clientPath}/projects/${sibling._id}`;
    const memberPath = `/users/${employee._id}/projects`;
    assert.equal((await request(admin, memberPath)).filter((row) => row.assigned).length, 0);
    await request(lead, memberPath, 'GET', undefined, 403);
    await request(lead, projectPath + '/people/' + employee._id, 'PUT', undefined, 403);
    await request(lead, siblingPath + '/people/' + coworker._id, 'PUT');
    const firstGrant = projectPath + '/people/' + employee._id;
    await request(employee, firstGrant, 'PUT', undefined, 403);
    await Promise.all([request(admin, firstGrant, 'PUT'), request(admin, firstGrant, 'PUT')]);
    assert.equal(await ProjectPermission.countDocuments({ user: employee._id }), 1);
    assert.deepEqual((await request(admin, memberPath)).filter((row) => row.assigned).map((row) => row._id), [String(project._id)]);
    assert.equal((await request(admin, projectPath + '/people')).find((person) => person._id === String(employee._id)).assigned, true);

    await request(employee, clientPath, 'GET', undefined, 403);
    await request(employee, siblingPath, 'GET', undefined, 403);
    await request(employee, siblingPath + '/work-items', 'GET', undefined, 403);
    await request(employee, projectPath + '/work-items', 'POST', { title: 'Blocked' }, 403);
    assert.equal((await request(employee, projectPath)).workspace.canManage, false);
    assert.deepEqual((await request(employee, projectPath + '/work-items')).map((row) => row._id), [String(item._id)]);
    assert.deepEqual((await request(employee, '/projects')).map((row) => row._id), [String(project._id)]);

    const byLead = await request(lead, '/tasks', 'POST', {
      title: 'Assigned Work', client: String(client._id), project: String(project._id),
      assignees: [String(employee._id)], dueDate: new Date().toISOString(),
    }, 201);
    const hidden = await Task.create({
      title: 'Sibling Work', client: client._id, project: sibling._id, assignees: [employee._id],
      dueDate: new Date(),
    });
    await request(employee, `/tasks/${byLead._id}`);
    await request(employee, `/tasks/${hidden._id}`, 'GET', undefined, 404);
    assert.equal(await ClientPermission.countDocuments({ user: employee._id }), 0);

    const date = clock().date;
    const dayPath = '/daily-work/day/' + date;
    const day = await request(employee, dayPath);
    const [dailyProject] = day.projects;
    assert.equal(day.projects.length, 1);
    assert.equal(dailyProject.workflowProjectId, String(project._id));
    assert.equal(day.workItems.length, 1);
    const [availableItem] = day.workItems;
    const saved = await request(employee, dayPath, 'PUT', { entries: [{
      projectId: dailyProject._id, title: availableItem.title, workItemId: availableItem.id,
      hours: 1, priority: 'normal', status: 'incomplete',
    }] });
    assert.equal(saved.entries[0].hours, 1);
    assert.equal((await request(employee, dayPath)).submission.entries.length, 1);
    const siblingDaily = (await request(coworker, dayPath)).projects[0];
    await request(employee, dayPath, 'PUT', { version: saved.version, entries: [{
      projectId: siblingDaily._id, title: 'Blocked', hours: 1, priority: 'normal', status: 'incomplete',
    }] }, 403);

    const assignedLead = await createUser('Project Lead', 'admin');
    await ClientPermission.create({ client: client._id, user: assignedLead._id, grantedBy: admin._id });
    const register = projectPath + '/work-items';
    await Task.create({ title: 'Own entry', client: client._id, project: project._id, assignees: [assignedLead._id],
      createdBy: assignedLead._id, dueDate: new Date() });
    assert.equal((await request(assignedLead, register + '/access')).canEdit, true);
    await Task.create({ title: 'Assigned project work', client: client._id, project: project._id,
      assignees: [assignedLead._id], dueDate: new Date() });
    assert.deepEqual(await request(assignedLead, register + '/access'), { canEdit: true, canArchive: false, role: 'admin' });
    const people = await request(assignedLead, register + '/assignees');
    assert.ok(people.some(({ _id }) => _id === String(employee._id)));
    assert.ok(!people.some(({ _id }) => _id === String(coworker._id)));
    const added = await request(assignedLead, register, 'POST', {
      title: 'Add to register', responsibleUser: String(employee._id),
    }, 201);
    const updated = await request(assignedLead, register + '/' + added._id, 'PATCH', { title: 'Edit register task' });
    assert.equal(updated.title, 'Edit register task');
    const newClient = await Client.create({ name: 'Unassigned Client' });
    const elsewhere = await ClientProject.create({ name: 'Unassigned Project', client: newClient._id });
    const elsewherePath = `/clients/${newClient._id}/projects/${elsewhere._id}`;
    await request(assignedLead, `/clients/${newClient._id}`, 'GET', undefined, 403);
    const otherItem = await request(assignedLead, elsewherePath + '/work-items', 'POST', { title: 'Added elsewhere' }, 201);
    await request(assignedLead, elsewherePath + '/work-items/' + otherItem._id, 'PATCH', { title: 'Edited elsewhere' });
    const dated = await request(assignedLead, '/tasks', 'POST', {
      title: 'Dated task elsewhere', client: String(newClient._id), project: String(elsewhere._id), dueDate: new Date().toISOString(),
    }, 201);
    await request(assignedLead, '/tasks/' + dated._id, 'PATCH', { title: 'Dated task edited elsewhere' });
    const scheduled = await request(assignedLead, '/templates', 'POST', {
      title: 'Recurring elsewhere', client: String(newClient._id), project: String(elsewhere._id),
      frequency: 'weekly', weekday: 1, startsOn: new Date().toISOString(),
    }, 201);
    await request(assignedLead, '/templates/' + scheduled.template._id + '/details', 'PATCH', {
      title: 'Recurring edited elsewhere', frequency: 'weekly', weekday: 2, startsOn: new Date().toISOString(),
    });
    assert.ok((await request(assignedLead, '/templates')).some((row) => row._id === scheduled.template._id && row.canEdit && !row.canDelete));
    await request(assignedLead, register + '/' + added._id, 'DELETE', undefined, 403);
    const activity = await request(assignedLead, '/audit');
    assert.deepEqual(new Set(activity.map(({ action }) => action)), new Set([
      'project.work.create', 'project.work.update', 'task.create', 'task.update', 'template.create', 'template.edit',
    ]));
    assert.ok(activity.some((row) => row.actor?._id === String(lead._id) && row.entityId === byLead._id));

    const statusPath = `${dayPath}/members/${employee._id}/entries/${saved.entries[0]._id}/status`;
    await request(employee, statusPath, 'PATCH', { version: saved.version, status: 'incomplete', reason: 'Waiting for the statement' });
    await request(admin, projectPath + '/people/' + manager._id, 'PUT');
    const report = (projectId, person = '') => `/daily-work/reports?from=${date}&to=${date}&projectId=${projectId}&memberId=${person}`;
    const assignedReport = await request(manager, report(dailyProject._id, employee._id));
    assert.equal(assignedReport.submissions[0].entries[0].incompleteReason, 'Waiting for the statement');
    assert.ok(assignedReport.members.some((row) => row.id === String(employee._id)));
    const insights = await request(manager, '/daily-work/project-insights/' + project._id);
    assert.equal(insights.projectId, dailyProject._id);
    assert.deepEqual(insights.budgets.map(({ hours, loggedHours, remainingHours }) => [hours, loggedHours, remainingHours]), [[3, 1, 2]]);
    await request(employee, '/daily-work/project-insights/' + project._id, 'GET', undefined, 403);
    await request(manager, '/daily-work/project-insights/' + sibling._id, 'GET', undefined, 403);
    await request(manager, '/tasks/' + hidden._id, 'GET', undefined, 404);
    await request(manager, '/tasks/' + byLead._id, 'PATCH', { project: String(sibling._id) }, 403);
    assert.equal((await request(manager, '/manager-workload?project=' + project._id)).totals.pending, await Task.countDocuments({ project: project._id, deletedAt: null, status: { $ne: 'done' } }));
    await AuditLog.create({ action: 'task.create', entity: 'Task', entityId: hidden._id, client: client._id, actor: lead._id, summary: 'Old sibling log' });
    await AuditLog.create({ action: 'task.create', entity: 'Task', entityId: byLead._id, client: client._id, actor: lead._id, summary: 'Old granted project log' });
    const managerActivity = await request(manager, '/audit');
    assert.ok(managerActivity.some((row) => row.summary === 'Old granted project log'));
    assert.ok(!managerActivity.some((row) => row.summary === 'Old sibling log'));

    const settings = '/settings/project-access';
    assert.equal((await request(admin, settings)).enabled, false);
    await request(manager, settings, 'PUT', { enabled: true }, 403);
    const hr = await request(admin, '/users', 'POST', { name: 'Human Resources', email: 'hr@test.example', role: 'hr' }, 201);
    assert.equal(hr.role, 'hr');
    const hrDirectory = await request(hr, '/users?dailyReport=1');
    assert.ok(hrDirectory.some((row) => row._id === String(employee._id) && row.dailyReport));
    assert.ok(hrDirectory.every((row) => !Object.hasOwn(row, 'slackUserId')));
    assert.ok((await request(hr, '/projects')).every((row) => !row.canManage));
    assert.ok((await request(hr, '/projects')).some(({ _id }) => _id === String(elsewhere._id)));
    const monitoredTask = await request(hr, '/tasks/' + hidden._id);
    assert.equal(monitoredTask.canEdit, false);
    assert.equal(monitoredTask.canChangeStatus, false);
    assert.ok((await request(hr, '/dashboard')).byPerson.some((row) => row._id === String(employee._id)));
    assert.ok((await request(hr, '/templates')).some((row) => row._id === scheduled.template._id && !row.canEdit && !row.canDelete));
    const monitoredReport = await request(hr, report(dailyProject._id, employee._id));
    assert.equal(monitoredReport.submissions[0].entries[0].incompleteReason, 'Waiting for the statement');
    assert.equal(monitoredReport.submissions[0].entries[0].canUpdateStatus, false);
    assert.equal(monitoredReport.slackEnabled, false);
    assert.equal((await request(hr, '/daily-work/project-insights/' + project._id)).budgets[0].remainingHours, 2);
    await request(hr, '/daily-work/missing/' + date);
    assert.ok((await request(hr, '/audit')).some((row) => row.summary === 'Old sibling log'));
    await request(hr, '/mail/threads', 'GET', undefined, 403);
    await request(hr, settings, 'GET', undefined, 403);
    await request(hr, '/users/' + employee._id, 'PATCH', { active: false }, 403);
    await request(hr, '/tasks/' + hidden._id, 'PATCH', { status: 'done' }, 403);
    await request(hr, statusPath, 'PATCH', { status: 'complete', version: monitoredReport.submissions[0].version }, 403);
    await request(hr, '/daily-work/reports/slack', 'POST', undefined, 403);
    const hrDay = await request(hr, dayPath);
    const hrProject = hrDay.projects.find((row) => row.workflowProjectId === String(elsewhere._id));
    const hrItem = hrDay.workItems.find((row) => row.projectId === hrProject._id);
    const hrEntry = {
      projectId: hrProject._id, workItemId: hrItem.id, title: hrItem.title,
      hours: 1, priority: 'normal', status: 'incomplete',
    };
    const hrSaved = await request(hr, dayPath, 'PUT', { memberId: String(employee._id), entries: [hrEntry] });
    assert.equal(hrSaved.memberId, String(hr._id));
    await request(hr, dayPath, 'PUT', { version: hrSaved.version, entries: [{ ...hrEntry, _id: hrSaved.entries[0]._id, hours: 0.5 }] });
    const ownReport = (await request(hr, report(hrProject._id, hr._id))).submissions[0];
    const ownEntry = ownReport.entries[0];
    assert.equal(ownEntry.hours, 0.5);
    assert.equal(ownEntry.canUpdateStatus, true);
    const completed = await request(hr, `${dayPath}/members/${hr._id}/entries/${ownEntry._id}/status`, 'PATCH', {
      status: 'complete', version: ownReport.version,
    });
    assert.equal(completed.entry.status, 'complete');
    assert.equal((await request(hr, report(dailyProject._id, employee._id))).submissions[0].entries[0].incompleteReason, 'Waiting for the statement');

    await request(admin, clientPath + '/assignments', 'POST', { adminId: hr._id }, 400);

    const grantsBefore = await ProjectPermission.countDocuments();
    await request(admin, settings, 'PUT', { enabled: true });
    const after = await ClientProject.create({ name: 'Future Project', client: newClient._id });
    const inactive = await Client.create({ name: 'Inactive Client', status: 'inactive' });
    const inactiveProject = await ClientProject.create({ name: 'Inactive Project', client: inactive._id });
    assert.deepEqual(new Set((await request(employee, '/projects')).map((row) => row._id)),
      new Set([project, sibling, elsewhere, after].map((row) => String(row._id))));
    await request(employee, `/clients/${inactive._id}/projects/${inactiveProject._id}`, 'GET', undefined, 403);
    await request(employee, clientPath, 'GET', undefined, 403);
    await request(employee, elsewherePath + '/work-items', 'POST', { title: 'Blocked' }, 403);
    await request(manager, '/tasks/' + hidden._id);
    await request(manager, '/daily-work/project-insights/' + sibling._id);
    assert.equal((await request(manager, '/manager-workload?project=' + sibling._id)).totals.pending, 1);
    assert.equal(await ProjectPermission.countDocuments(), grantsBefore);
    await request(admin, settings, 'PUT', { enabled: false });
    assert.deepEqual((await request(employee, '/projects')).map((row) => row._id), [String(project._id)]);
    await request(manager, '/tasks/' + hidden._id, 'GET', undefined, 404);
    assert.equal(await ProjectPermission.countDocuments(), grantsBefore);

    await request(admin, projectPath, 'DELETE');
    assert.deepEqual(await request(employee, '/projects'), []);
    assert.deepEqual((await request(employee, dayPath)).projects, []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

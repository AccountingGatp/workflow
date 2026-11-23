import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { clock } from '../src/daily-work/dates.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import {
  Client, ClientAssignment, ClientPermission, ClientProject, ProjectPermission,
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
    const [admin, lead, employee, coworker] = await Promise.all([
      createUser('Test Owner', 'super_admin'), createUser('Test Lead', 'admin'),
      createUser('Test Employee', 'employee'), createUser('Test Coworker', 'employee'),
    ]);
    const client = await Client.create({ name: 'Fixture Client' });
    const [project, sibling] = await ClientProject.create([
      { name: 'First Project', client: client._id }, { name: 'Second Project', client: client._id },
    ]);
    const [item] = await ProjectWorkItem.create([
      { title: 'First Work Item', project: project._id, client: client._id },
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
    assert.equal((await request(assignedLead, register + '/access')).canEdit, false);
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
    await request(assignedLead, siblingPath + '/work-items', 'POST', { title: 'Blocked' }, 403);
    await request(assignedLead, register + '/' + added._id, 'DELETE', undefined, 403);
    const activity = await request(assignedLead, '/audit');
    assert.deepEqual(new Set(activity.map(({ action }) => action)), new Set(['project.work.create', 'project.work.update']));

    await request(admin, projectPath, 'DELETE');
    assert.deepEqual(await request(employee, '/projects'), []);
    assert.deepEqual((await request(employee, dayPath)).projects, []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

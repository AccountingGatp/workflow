import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import { User, Client, Team, TeamMembership, ClientAssignment, ClientPermission, ClientProject, Task } from '../src/models/index.js';
import { dailyModels } from '../src/daily-work/models.js';
import { clock, shiftDate } from '../src/daily-work/dates.js';
import { runDailyWorkJobs } from '../src/daily-work/jobs.js';

test('isolated daily work, scoped catalog and reports, Slack threads and scheduled attendance', async () => {
  const db = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] } });
  const realFetch = globalThis.fetch;
  const calls = [];
  let server;
  try {
    await mongoose.connect(db.getUri('workflow_test'));
    process.env.DAILY_WORK_DB_NAME = 'daily_test';
    process.env.DAILY_WORK_SLACK_TOKEN = 'mock-token';
    process.env.DAILY_WORK_SLACK_CHANNEL = 'mock-channel';
    globalThis.fetch = (url, options) => {
      if (String(url) !== 'https://slack.com/api/chat.postMessage') return realFetch(url, options);
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return Promise.resolve(Response.json({ ok: true, channel: payload.channel, ts: String(calls.length) + '.000001' }));
    };
    handleErrors(app);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/daily-work`;
    async function request(user, path, method = 'GET', body, status = 200) {
      const response = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ sub: String(user._id) }, JWT_SECRET) },
        body: body && JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    }

    async function person(name, role) {
      return User.create({ name, role, email: `${name}@example.test`, passwordHash: 'fixture-only' });
    }
    const [owner, lead, employee, other] = await Promise.all([
      person('owner', 'super_admin'), person('lead', 'admin'), person('employee', 'employee'), person('other', 'employee'),
    ]);
    const [client, team] = await Promise.all([Client.create({ name: 'Company' }), Team.create({ name: 'Team' })]);
    const project = await ClientProject.create({ client: client._id, name: 'Accounting' });
    await TeamMembership.create([{ user: lead._id, team: team._id, teamRole: 'lead' }, { user: employee._id, team: team._id }]);
    await ClientAssignment.create({ client: client._id, team: team._id });
    await ClientPermission.create({ client: client._id, user: employee._id, grantedBy: lead._id });
    const date = clock().date;
    const previousDate = shiftDate(date, -1);
    const source = await Task.create({ client: client._id, project: project._id, title: 'Review ledger', assignees: [employee._id], dueDate: new Date(date) });
    const draft = { clientId: String(client._id), workflowProjectId: String(project._id), name: 'Accounting' };
    await request(employee, '/projects', 'POST', draft, 403);
    const daily = await request(lead, '/projects', 'POST', draft, 201);
    await request(lead, `/projects/${daily._id}/catalog`, 'POST', {
      items: [{ title: 'Book payroll', hours: 1.5 }, { title: 'Check vendor statements', hours: 0.5 }],
    }, 201);
    await request(lead, `/projects/${daily._id}/members/${employee._id}`, 'PUT', { hours: 2 });
    await request(lead, `/members/${employee._id}`, 'PUT', { enrolled: true, shift: 'afternoon', reportFrom: date });
    const day = await request(employee, `/day/${date}`);
    assert.deepEqual(day.suggestions.map((row) => row.id), [String(source._id)]);
    assert.equal(day.catalog.find((row) => row.title === 'Book payroll').hours, 1.5);
    assert.equal(day.assignments[0].hours, 2);
    assert.deepEqual((await request(other, `/day/${date}`)).projects, []);
    assert.equal((await request(lead, `/missing/${date}`)).missing[0].id, String(employee._id));
    assert.equal((await request(other, `/missing/${date}`)).expected, 0);
    assert.equal((await request(lead, `/missing/${previousDate}`)).expected, 0);

    const entry = { title: 'Review ledger', projectId: daily._id, workflowTaskId: String(source._id), hours: 2, status: 'incomplete', priority: 'high' };
    await request(other, `/day/${date}`, 'PUT', { entries: [entry] }, 403);
    const original = await request(employee, `/day/${date}`, 'PUT', { entries: [entry] });
    assert.equal(original.delivery, 'sent');
    assert.equal(calls[0].thread_ts, undefined);
    const changed = await request(employee, `/day/${date}`, 'PUT', {
      entries: [{ ...original.entries[0], hours: 2.25, status: 'complete' }], version: original.version,
    });
    assert.equal(calls[1].thread_ts, '1.000001');
    assert.equal(calls[1].reply_broadcast, false);
    assert.match(calls[1].text, /2.25 h/);
    const unchanged = await request(employee, `/day/${date}`, 'PUT', { entries: changed.entries, version: changed.version });
    assert.equal(unchanged.version, changed.version);
    assert.equal(calls.length, 2);
    await request(employee, `/day/${date}`, 'PUT', { entries: [], version: original.version }, 409);
    assert.equal((await request(lead, `/reports?from=${date}&status=complete`)).submissions.length, 1);
    assert.equal((await request(other, `/reports?from=${date}`)).submissions.length, 0);
    assert.equal((await request(owner, `/reports?from=${date}`)).submissions.length, 1);

    process.env.DAILY_WORK_SLACK_REPORTS = 'true';
    process.env.DAILY_WORK_REPORT_DAYS = '0,1,2,3,4,5,6';
    const scheduled = new Date(`${date}T10:00:00.000Z`);
    await runDailyWorkJobs(scheduled);
    await runDailyWorkJobs(scheduled);
    assert.equal(calls.length, 3);
    assert.match(calls[2].text, /All employees submitted/);
    await request(employee, `/day/${date}`, 'PUT', { entries: [], version: changed.version });
    assert.equal(calls[3].thread_ts, '1.000001');
    assert.match(calls[3].text, /All tasks removed/);

    delete process.env.DAILY_WORK_SLACK_TOKEN;
    const localOnly = await request(employee, `/day/${previousDate}`, 'PUT', { entries: [{ ...entry, workflowTaskId: undefined }] });
    process.env.DAILY_WORK_SLACK_TOKEN = 'mock-token';
    await request(employee, `/day/${previousDate}`, 'PUT', { entries: [], version: localOnly.version });
    assert.equal(calls.length, 4);
    await request(lead, `/members/${employee._id}/leave/${date}`, 'PUT', {});
    assert.equal((await request(owner, `/missing/${date}`)).expected, 0);
    assert.equal((await dailyModels()).Submission.db.name, 'daily_test');
    assert.equal(mongoose.connection.name, 'workflow_test');
    assert.equal((await Task.findById(source._id)).status, 'todo');
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

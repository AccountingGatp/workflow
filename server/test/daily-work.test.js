import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import { User, Client, Team, TeamMembership, ClientAssignment, ClientPermission, ClientProject, ProjectWorkItem, Task, TaskTemplate } from '../src/models/index.js';
import { dailyModels } from '../src/daily-work/models.js';
import { clock, shiftDate } from '../src/daily-work/dates.js';
import { runDailyWorkJobs } from '../src/daily-work/jobs.js';

test('isolated daily work, scoped catalog and reports, Slack threads and scheduled attendance', async () => {
  const db = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
  });
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
      const response = await fetch((path.startsWith('/tasks/') ? base.replace(/\/daily-work$/, '') : base) + path, {
        method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ sub: String(user._id) }, JWT_SECRET) },
        body: body && JSON.stringify(body),
      });
      const data = await response.json();
      assert.ok([status].flat().includes(response.status), JSON.stringify(data));
      if (Array.isArray(status)) return response.status;
      return data;
    }

    async function person(name, role) {
      return User.create({ name, role, email: `${name}@example.test`, passwordHash: 'fixture-only' });
    }
    const [owner, lead, employee, other] = await Promise.all([
      person('owner', 'super_admin'), person('Simran', 'admin'), person('employee', 'employee'), person('other', 'employee'),
    ]);
    const [client, team] = await Promise.all([Client.create({ name: 'Company' }), Team.create({ name: 'Team' })]);
    const project = await ClientProject.create({ client: client._id, name: 'Accounting' });
    await TeamMembership.create([{ user: lead._id, team: team._id, teamRole: 'lead' }, { user: employee._id, team: team._id }]);
    await ClientAssignment.create({ client: client._id, team: team._id });
    await ClientPermission.create({ client: client._id, user: employee._id, grantedBy: lead._id });
    const date = clock().date;
    const previousDate = shiftDate(date, -1);
    const master = await ProjectWorkItem.create({ client: client._id, project: project._id,
      title: 'Review ledger', responsibleUser: employee._id, weeklyHours: '20 min monthly' });
    const source = await Task.create({ client: client._id, project: project._id, masterItem: master._id, title: master.title,
      assignees: [employee._id], dueDate: new Date(date), checklist: [{ text: 'Check totals' }] });
    const legacyProject = new mongoose.Types.ObjectId();
    const legacyDatabase = mongoose.connection.useDb('daily_test', { useCache: true }).db;
    await legacyDatabase.collection('projects').insertOne({ _id: legacyProject, clientId: String(client._id), name: 'Legacy', archived: false });
    await legacyDatabase.collection('task_catalog').insertOne({ projectId: String(legacyProject), title: 'Untimed catalog', hours: 2, archived: false });
    const draft = { clientId: String(client._id), workflowProjectId: String(project._id), name: 'Accounting' };
    await request(employee, '/projects', 'POST', draft, 403);
    await request(lead, '/projects', 'POST', draft, 403);
    await request(lead, '/manage', 'GET', undefined, 403);
    await request(employee, '/manage', 'GET', undefined, 403);
    const synced = await request(employee, `/day/${date}`);
    const daily = synced.projects.find((row) => row.workflowProjectId === String(project._id));
    assert.equal(daily.clientName, 'Company');
    assert.equal(synced.workItems.find((row) => row.id === String(master._id)).hours, 0.33);
    assert.equal((await request(employee, `/day/${date}`)).projects.filter((row) => row.workflowProjectId === String(project._id)).length, 1);
    await request(lead, `/projects/${daily._id}/catalog`, 'POST', { title: 'Blocked', hours: 1 }, 403);
    await request(lead, `/projects/${daily._id}/members/${employee._id}`, 'PUT', { hours: 2 }, 403);
    await request(lead, '/projects/import', 'POST', { text: 'Blocked' }, 403);
    await request(owner, `/projects/${daily._id}/catalog`, 'POST', {
      items: [{ title: 'Book payroll', hours: 1.5 }, { title: 'Check vendor statements', hours: 0.5 }, { title: 'Review ledger', hours: 3 }],
    }, 201);
    await request(owner, `/projects/${daily._id}/members/${employee._id}`, 'PUT', { hours: 2 });
    await request(owner, `/members/${employee._id}`, 'PUT', { enrolled: true, shift: 'afternoon', reportFrom: date });
    const day = await request(employee, `/day/${date}`);
    assert.equal(day.workItems.find((row) => row.id === String(master._id)).occurrence.id, String(source._id));
    assert.equal(day.catalog.find((row) => row.title === 'Book payroll').hours, 1.5);
    assert.equal(day.assignments[0].hours, 2);
    assert.deepEqual((await request(other, `/day/${date}`)).projects, []);
    assert.ok(!day.catalog.some((task) => task.title === 'Review'));
    const managed = await request(owner, '/manage');
    assert.ok(managed.catalog.some((task) => task.projectId === String(legacyProject) && task.title === 'Review'));
    assert.equal(managed.catalog.find((task) => task.title === 'Untimed catalog').period, 'daily');
    assert.equal((await request(lead, `/missing/${date}`)).missing[0].id, String(employee._id));
    assert.equal((await request(other, `/missing/${date}`)).expected, 0);
    assert.equal((await request(lead, `/missing/${previousDate}`)).expected, 0);

    const entry = { title: 'Review ledger', projectId: daily._id, workflowTaskId: String(source._id), hours: 2, status: 'incomplete', priority: 'high' };
    await request(other, `/day/${date}`, 'PUT', { entries: [entry] }, 403);
    const original = await request(employee, `/day/${date}`, 'PUT', { entries: [entry] });
    assert.equal(original.delivery, 'sent');
    assert.equal(calls[0].thread_ts, undefined);
    const changed = await request(employee, `/day/${date}`, 'PUT', {
      entries: [{ ...original.entries[0], hours: 2.25, status: 'complete', checklistChanges: [{ id: String(source.checklist[0]._id), done: true }] }], version: original.version,
    });
    assert.equal(calls[1].thread_ts, '1.000001');
    assert.equal(calls[1].reply_broadcast, false);
    assert.match(calls[1].text, /2.25 h/);
    assert.equal(changed.entries[0].workflowStatus, 'pending_review');
    assert.match(calls[1].text, /awaiting TL review/);
    assert.equal((await request(employee, `/tasks/${source._id}`)).checklist[0].done, true);
    const unchanged = await request(employee, `/day/${date}`, 'PUT', { entries: changed.entries, version: changed.version });
    assert.equal(unchanged.version, changed.version);
    assert.equal(calls.length, 2);
    await request(employee, `/day/${date}`, 'PUT', { entries: [], version: original.version }, 409);
    assert.equal((await request(lead, `/reports?from=${date}&status=complete`)).submissions.length, 0);
    await request(lead, `/tasks/${source._id}`, 'PATCH', { confirmCompletion: true });
    assert.equal((await request(lead, `/reports?from=${date}&status=complete`)).submissions.length, 1);
    assert.equal((await request(employee, `/day/${date}`)).submission.entries[0].status, 'complete');
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
    await request(owner, `/members/${employee._id}/leave/${date}`, 'PUT', {});
    assert.equal((await request(owner, `/missing/${date}`)).expected, 0);
    assert.equal((await dailyModels()).Submission.db.name, 'daily_test');
    assert.equal(mongoose.connection.name, 'workflow_test');
    assert.equal((await Task.findById(source._id)).status, 'done');

    delete process.env.DAILY_WORK_SLACK_TOKEN;
    await request(owner, `/projects/${daily._id}/catalog`, 'POST', { items: [
      { title: 'Month end', hours: 8, period: 'monthly' },
      { title: 'Weekly report', hours: 3, period: 'weekly' },
      { title: 'Daily bank import', hours: 2, period: 'daily' },
    ] }, 201);
    const getDay = (user, day) => request(user, `/day/${day}`);
    const log = (user, day, entries, expected = 200, version) =>
      request(user, `/day/${day}`, 'PUT', { entries, version }, expected);
    const time = (title, hours, projectId = daily._id) => ({ title, hours, projectId, status: 'complete', priority: 'normal' });

    await log(employee, '2026-10-05', [time('Month end', 1), time('Weekly report', 2), time('Daily bank import', 2)]);
    const available = (await getDay(employee, '2026-10-06')).catalog;
    assert.equal(available.find((task) => task.title === 'Month end').remainingHours, 7);
    assert.equal(available.find((task) => task.title === 'Weekly report').remainingHours, 1);
    assert.equal(available.find((task) => task.title === 'Daily bank import').remainingHours, 2);
    await log(employee, '2026-10-06', [time('MONTH END', 7.01)], 400);
    await log(employee, '2026-10-06', [time('Weekly report', 1.01)], 400);
    await log(employee, '2026-10-06', [time('Daily bank import', 1), time('daily bank import', 1.01)], 400);
    await log(employee, '2026-10-06', [time(' Review ', 0.25)], 403);
    const results = await Promise.all([
      log(employee, '2026-10-06', [time('Month end', 4)], [200, 400]),
      log(employee, '2026-10-07', [time('Month end', 4)], [200, 400]),
    ]);
    assert.deepEqual(results.sort(), [200, 400]);
    const consumed = (await getDay(employee, '2026-10-06')).submission ? '2026-10-06' : '2026-10-07';
    const consumedSubmission = (await getDay(employee, consumed)).submission;
    await log(employee, consumed, [], 200, consumedSubmission.version);
    assert.equal((await getDay(employee, '2026-10-08')).catalog.find((task) => task.title === 'Month end').remainingHours, 7);
    assert.equal((await getDay(employee, '2026-10-12')).catalog.find((task) => task.title === 'Weekly report').remainingHours, 3);
    assert.equal((await getDay(employee, '2026-11-01')).catalog.find((task) => task.title === 'Month end').remainingHours, 8);

    const shared = await ProjectWorkItem.create({ client: client._id, project: project._id, title: 'New client work' });
    const linked = await log(employee, '2026-10-09', [{ ...time(shared.title, 1), workItemId: String(shared._id) }]);
    const linkedTask = await request(employee, `/tasks/${linked.entries[0].workflowTaskId}`);
    assert.equal(linkedTask.masterItem._id, String(shared._id));
    assert.equal(linkedTask.status, 'pending_review');
    await log(employee, '2026-10-09', linked.entries, 200, linked.version);
    assert.equal(await Task.countDocuments({ masterItem: shared._id }), 1);

    const payroll = await ProjectWorkItem.create({ client: client._id, project: project._id,
      title: 'Payroll', notes: 'Reconcile payroll before posting', weeklyHours: '4 hours', frequency: 'Weekly-Friday' });
    const payrollSchedule = await TaskTemplate.create({ title: payroll.title, client: client._id, project: project._id,
      masterItem: payroll._id, assignees: [employee._id], frequency: 'weekly', weekday: 5, startsOn: new Date('2026-10-01') });
    const payrollEntry = { ...time(payroll.title, 2), status: 'incomplete', workItemId: String(payroll._id) };
    const early = await log(employee, '2026-10-19', [payrollEntry]);
    const next = await getDay(employee, '2026-10-20');
    const payrollBudget = next.catalog.find((row) => row.workItemId === String(payroll._id));
    assert.equal(payrollBudget.remainingHours, 2);
    assert.equal(payrollBudget.period, 'weekly');
    assert.equal(next.workItems.find((row) => row.id === String(payroll._id)).description, payroll.notes);
    await log(employee, '2026-10-20', [{ ...payrollEntry, hours: 2.01 }], 400);
    const later = await log(employee, '2026-10-20', [payrollEntry]);
    assert.equal(later.entries[0].workflowTaskId, early.entries[0].workflowTaskId);
    assert.equal(await Task.countDocuments({ template: payrollSchedule._id }), 1);
    assert.equal((await getDay(employee, '2026-10-26')).catalog.find((row) => row.workItemId === String(payroll._id)).remainingHours, 4);

    const leadCatalog = (await getDay(lead, '2026-10-05')).catalog;
    assert.equal(leadCatalog.filter((task) => task.review).length, 2);
    await log(owner, '2026-10-05', [time('Review', 1)], 403);
    await log(lead, '2026-10-05', [time('Review', 0.6), time('Review', 0.41, String(legacyProject))], 400);
    await log(lead, '2026-10-05', [time('Review', 0.6), time('Review', 0.4, String(legacyProject))]);
    await log(lead, '2026-10-06', [time('Review', 1)]);
    assert.equal((await getDay(lead, '2026-10-05')).catalog.find((task) => task.title === 'Month end').remainingHours, 8);
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

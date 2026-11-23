import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import { User, Client, Team, TeamMembership, ClientAssignment, ClientPermission, ClientProject, ProjectWorkItem, Task, TaskTemplate } from '../src/models/index.js';
import { dailyModels } from '../src/daily-work/models.js';
import { setCurrentLeave } from '../src/daily-work/leave.js';
import { clock, shiftDate } from '../src/daily-work/dates.js';
import { runDailyWorkJobs } from '../src/daily-work/jobs.js';
import { dailySubmissionText } from '../src/daily-work/slack.js';

test('daily Slack text groups numbered tasks and matches the requested layout', () => {
  const report = { memberName: 'Pooja Kasera', date: '2026-11-19', entries: [
    { projectId: 'lxp', projectName: 'lxp-enterprises-llc', title: 'FCB Deposits Creation', hours: 1, priority: 'normal' },
    { projectId: 'lxp', projectName: 'lxp-enterprises-llc', title: 'Other task', hours: 2.5, priority: 'normal' },
  ] };
  assert.equal(dailySubmissionText(report, 'U08S464N7E2'), [
    '<@U08S464N7E2> Employee: Pooja Kasera',
    'Date: Thursday, November 19th, 2026',
    ':bar_chart: Summary: 1 project, 3.5 hours total',
    'Projects:',
    '1. lxp-enterprises-llc - 3.5 hours',
    '   Task 1: FCB Deposits Creation (1h) - Priority: Medium',
    '   Task 2: Other task (2.5h) - Priority: Medium',
  ].join('\n'));
  const twoProjects = dailySubmissionText({ ...report, date: '2026-11-21', entries: [
    ...report.entries,
    { projectId: 'other', projectName: 'Other project', title: 'Reconcile', hours: 0.5, priority: 'high' },
  ] });
  assert.match(twoProjects, /^Employee: Pooja Kasera\nDate: Saturday, November 21st, 2026\n:bar_chart: Summary: 2 projects, 4 hours total/m);
  assert.match(twoProjects, /2\. Other project - 0\.5 hours\n   Task 1: Reconcile \(0\.5h\) - Priority: High/);
});

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
      const response = await fetch((/^\/(tasks|clients|templates|users|settings\/mail|mail)(?:[/?]|$)/.test(path) ? base.replace(/\/daily-work$/, '') : base) + path, {
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
    const [owner, lead, employee, other, manager] = await Promise.all([
      person('owner', 'super_admin'), person('Simran', 'admin'), person('employee', 'employee'), person('other', 'employee'), person('manager', 'manager'),
    ]);
    assert.deepEqual(await request(employee, '/settings/mail'), { enabled: true });
    await request(employee, '/settings/mail', 'PUT', { enabled: false }, 403);
    await request(owner, '/settings/mail', 'PUT', { enabled: 'false' }, 400);
    assert.deepEqual(await request(owner, '/settings/mail', 'PUT', { enabled: false }), { enabled: false });
    assert.deepEqual(await request(employee, '/settings/mail'), { enabled: false });
    await request(employee, '/mail/threads', 'GET', undefined, 403);
    await request(owner, '/mail/accounts', 'GET', undefined, 403);
    await request(owner, '/mail/oauth/callback', 'GET', undefined, 403);
    await request(owner, '/settings/mail', 'PUT', { enabled: true });
    assert.deepEqual(await request(employee, '/mail/threads'), []);

    const [client, team] = await Promise.all([Client.create({ name: 'Company' }), Team.create({ name: 'Team' })]);
    const project = await ClientProject.create({ client: client._id, name: 'Accounting' });
    await TeamMembership.create([{ user: lead._id, team: team._id, teamRole: 'lead' }, { user: employee._id, team: team._id }]);
    await ClientAssignment.create([{ client: client._id, team: team._id }, { client: client._id, admin: manager._id }]);
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

    await request(employee, `/tasks/${source._id}`, 'PATCH', { title: 'Blocked employee edit' }, 403);
    assert.equal((await request(lead, `/tasks/${source._id}`)).canEdit, true);
    assert.equal((await request(manager, `/tasks/${source._id}`)).canEdit, true);
    await request(manager, `/tasks/${source._id}`, 'PATCH', { priority: 'low' });
    const masterPath = `/clients/${client._id}/projects/${project._id}/work-items/${master._id}`;
    await request(employee, masterPath, 'PATCH', { title: master.title }, 403);
    await request(lead, masterPath, 'PATCH', { title: master.title, responsibleUser: String(employee._id) });
    await request(lead, masterPath, 'DELETE', undefined, 403);
    await request(manager, masterPath, 'PATCH', { title: master.title, notes: 'Master description' });

    const created = await request(owner, '/users', 'POST', {
      name: 'New Slack member', email: 'new-slack@example.test', password: 'example-pass', slackUserId: 'u123new',
    }, 201);
    assert.equal(created.slackUserId, 'U123NEW');
    await request(employee, `/users/${employee._id}`, 'PATCH', { slackUserId: 'U999OTHER' }, 403);
    await request(owner, `/users/${employee._id}`, 'PATCH', { slackUserId: '<@U123TEST>' }, 400);
    await request(owner, `/users/${employee._id}`, 'PATCH', { slackUserId: ' U123TEST ' });
    assert.equal((await request(owner, '/users')).find((user) => user._id === String(employee._id)).slackUserId, 'U123TEST');
    assert.equal((await request(lead, '/users')).find((user) => user._id === String(employee._id)).slackUserId, undefined);
    const cleared = await request(owner, `/users/${created._id}`, 'PATCH', { slackUserId: '' });
    assert.equal(cleared.slackUserId, null);

    const entry = { title: 'Review ledger', projectId: daily._id, workflowTaskId: String(source._id), hours: 2, status: 'incomplete', priority: 'high' };
    await request(other, `/day/${date}`, 'PUT', { entries: [entry] }, 403);
    const put = (user, day, entries, version) => request(user, `/day/${day}`, 'PUT', { entries, version });
    const send = (user, day, version) => request(user, `/day/${day}/slack`, 'POST', { version });
    const original = await put(employee, date, [{ ...entry, note: 'Check <this> first' }]);
    assert.equal(original.delivery, 'skipped');
    assert.equal(original.entries[0].note, 'Check <this> first');
    assert.equal(original.entries[0].description, 'Master description');
    assert.equal(calls.length, 0);
    const posted = await send(employee, date, original.version);
    assert.equal(posted.delivery, 'sent');
    assert.equal(posted.slackPosted, true);
    assert.equal(calls[0].thread_ts, undefined);
    assert.match(calls[0].text, /^<@U123TEST> Employee: employee/);
    assert.match(calls[0].text, /Note: Check &lt;this&gt; first/);
    await send(employee, date, posted.version);
    assert.equal(calls.length, 1);
    await request(employee, `/day/${date}`, 'PUT', { entries: [{ ...original.entries[0], hours: 2.25 }], version: posted.version }, 400);
    const changed = await put(employee, date, [{ ...original.entries[0], note: '', hours: 1.75, status: 'complete',
      checklistChanges: [{ id: String(source.checklist[0]._id), done: true }] }], posted.version);
    assert.equal(changed.entries[0].note, '');
    assert.equal(changed.entries[0].workflowStatus, 'done');
    assert.equal(calls.length, 1);
    const updated = await send(employee, date, changed.version);
    assert.equal(calls[1].thread_ts, '1.000001');
    assert.equal(calls[1].reply_broadcast, false);
    assert.match(calls[1].text, /Task 1: Review ledger \(1\.75h\) - Priority: High/);
    await request(employee, `/day/${date}`, 'PUT', { entries: [{ ...updated.entries[0], hours: 1.8 }], version: updated.version }, 400);
    assert.match(calls[1].text, /^Employee: employee/);
    assert.equal((await request(employee, `/tasks/${source._id}`)).checklist[0].done, true);
    const unchanged = await request(employee, `/day/${date}`, 'PUT', { entries: updated.entries, version: updated.version });
    assert.equal(unchanged.version, updated.version);
    assert.equal(calls.length, 2);
    await request(employee, `/day/${date}`, 'PUT', { entries: [], version: original.version }, 409);
    assert.equal((await request(lead, `/reports?from=${date}&status=complete`)).submissions.length, 1);
    const statusPath = `/day/${date}/members/${employee._id}/entries/${updated.entries[0]._id}/status`;
    const setStatus = (actor, status, version, reason, code = 200) => request(actor, statusPath, 'PATCH', { status, version, reason }, code);
    const leadReport = await request(lead, `/reports?from=${date}`);
    assert.equal(leadReport.submissions[0].entries[0].canUpdateStatus, true);
    assert.equal((await request(employee, `/reports?from=${date}`)).submissions[0].entries[0].canUpdateStatus, true);
    await setStatus(other, 'complete', updated.version, undefined, 403);
    await setStatus(lead, 'incomplete', updated.version, ' ', 400);
    const returned = await setStatus(lead, 'incomplete', updated.version, 'Awaiting client approval');
    assert.equal(returned.entry.incompleteReason, 'Awaiting client approval');
    assert.equal(returned.entry.workflowStatus, 'in_progress');
    assert.equal(returned.entry.hours, 1.75);
    await setStatus(employee, 'complete', updated.version, undefined, 409);
    const leadCompleted = await setStatus(lead, 'complete', returned.version);
    assert.equal((await request(employee, `/reports?from=${date}`)).submissions[0].entries[0].canUpdateStatus, false);
    await setStatus(employee, 'incomplete', leadCompleted.version, 'Missing statement', 403);
    const leadReopened = await setStatus(lead, 'incomplete', leadCompleted.version, 'Missing statement');
    const employeeCompleted = await setStatus(employee, 'complete', leadReopened.version);
    assert.equal(employeeCompleted.entry.canUpdateStatus, true);
    const reopened = await setStatus(employee, 'incomplete', employeeCompleted.version, 'Marked complete by mistake');
    assert.equal(reopened.entry.incompleteReason, 'Marked complete by mistake');
    assert.equal(reopened.entry.workflowStatus, 'in_progress');
    const completed = await setStatus(employee, 'complete', reopened.version);
    assert.equal(completed.entry.workflowStatus, 'done');
    assert.equal(completed.entry.incompleteReason, undefined);
    assert.equal(completed.entry.status, 'complete');
    assert.equal((await request(lead, `/reports?from=${date}&status=complete`)).submissions.length, 1);
    assert.equal((await request(employee, `/day/${date}`)).submission.entries[0].status, 'complete');
    assert.equal((await request(other, `/reports?from=${date}`)).submissions.length, 0);
    assert.equal((await request(owner, `/reports?from=${date}`)).submissions.length, 1);

    const removed = await put(employee, date, [], completed.version);
    assert.equal(calls.length, 2);
    await send(employee, date, removed.version);
    assert.equal(calls[2].thread_ts, '1.000001');
    assert.match(calls[2].text, /All tasks removed/);

    delete process.env.DAILY_WORK_SLACK_TOKEN;
    const localOnly = await request(employee, `/day/${previousDate}`, 'PUT', { entries: [{ ...entry, workflowTaskId: undefined }] });
    process.env.DAILY_WORK_SLACK_TOKEN = 'mock-token';
    await request(employee, `/day/${previousDate}`, 'PUT', { entries: [], version: localOnly.version });
    assert.equal(calls.length, 3);

    const readyToResend = await put(employee, previousDate, [{ ...entry, workflowTaskId: undefined }],
      (await request(employee, `/day/${previousDate}`)).submission.version);
    const originalPost = await send(employee, previousDate, readyToResend.version);
    assert.equal(originalPost.canSendToNewSlackChannel, false);

    process.env.DAILY_WORK_SLACK_CHANNEL = 'new-channel';
    try {
      const { submission: existingDay } = await request(employee, `/day/${previousDate}`);
      assert.equal(existingDay.canSendToNewSlackChannel, true);
      assert.equal(existingDay.version, originalPost.version);
      const reposted = await send(employee, previousDate, existingDay.version);
      assert.equal(reposted.delivery, 'sent');
      assert.equal(reposted.canSendToNewSlackChannel, false);
      assert.equal(calls.at(-1).channel, 'new-channel');
      assert.equal(calls.at(-1).thread_ts, undefined);
      assert.match(calls.at(-1).text, /^<@U123TEST> Employee: employee/);
      assert.equal(calls.length, 5);
      await send(employee, previousDate, reposted.version);
      assert.equal(calls.length, 5);

      const edited = await put(employee, previousDate, [{ ...reposted.entries[0], note: 'Updated note' }], reposted.version);
      await send(employee, previousDate, edited.version);
      assert.equal(calls.at(-1).channel, 'new-channel');
      assert.equal(calls.at(-1).thread_ts, '5.000001');
    } finally {
      process.env.DAILY_WORK_SLACK_CHANNEL = 'mock-channel';
    }
    await request(owner, `/members/${employee._id}/leave/${date}`, 'PUT', {});
    assert.equal((await request(owner, `/missing/${date}`)).expected, 0);
    const leavePath = `/users/${employee._id}/leave`;
    await request(lead, leavePath, 'PUT', { onLeave: true }, 403);
    await request(owner, leavePath, 'PUT', { onLeave: false });
    const availability = async () => (await request(owner, '/users?dailyReport=1'))
      .find((person) => person._id === String(employee._id)).onLeave;
    assert.equal(await availability(), false);
    await request(owner, leavePath, 'PUT', { onLeave: true });
    assert.equal(await availability(), true);
    assert.equal((await request(owner, `/missing/${shiftDate(date, 1)}`)).expected, 0);
    assert.equal((await request(employee, `/day/${date}`)).date, date);
    await request(owner, leavePath, 'PUT', { onLeave: false });
    assert.equal(await availability(), false);
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

    await log(employee, '2026-10-05', [time('Month end', 1), time('Weekly report', 2), time('Daily bank import', 2), time('Book payroll', 1)]);
    const teammateCatalog = (await getDay(lead, '2026-10-05')).catalog;
    assert.equal(teammateCatalog.find((task) => task.title === 'Book payroll').remainingHours, 0.5);
    await log(lead, '2026-10-05', [time('Book payroll', 0.51)], 400);
    const teammateNextDay = (await getDay(lead, '2026-10-06')).catalog;
    assert.equal(teammateNextDay.find((task) => task.title === 'Book payroll').remainingHours, 1.5);
    assert.equal(teammateNextDay.find((task) => task.title === 'Weekly report').remainingHours, 1);
    assert.equal(teammateNextDay.find((task) => task.title === 'Month end').remainingHours, 7);
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
      log(lead, '2026-10-07', [time('Month end', 4)], [200, 400]),
    ]);
    assert.deepEqual(results.sort(), [200, 400]);
    const employeeSubmission = (await getDay(employee, '2026-10-06')).submission;
    const winningUser = employeeSubmission ? employee : lead;
    const consumed = employeeSubmission ? '2026-10-06' : '2026-10-07';
    const consumedSubmission = (await getDay(winningUser, consumed)).submission;
    await log(winningUser, consumed, [], 200, consumedSubmission.version);
    assert.equal((await getDay(employee, '2026-10-08')).catalog.find((task) => task.title === 'Month end').remainingHours, 7);
    assert.equal((await getDay(employee, '2026-10-12')).catalog.find((task) => task.title === 'Weekly report').remainingHours, 3);
    assert.equal((await getDay(employee, '2026-11-01')).catalog.find((task) => task.title === 'Month end').remainingHours, 8);

    const shared = await ProjectWorkItem.create({ client: client._id, project: project._id, title: 'New client work' });
    const linked = await log(employee, '2026-10-09', [{ ...time(shared.title, 1), workItemId: String(shared._id) }]);
    const linkedTask = await request(employee, `/tasks/${linked.entries[0].workflowTaskId}`);
    assert.equal(linkedTask.masterItem._id, String(shared._id));
    assert.equal(linkedTask.status, 'done');
    assert.deepEqual(linkedTask.activity.map((row) => row.action), ['task.create']);
    await log(employee, '2026-10-09', linked.entries, 200, linked.version);
    assert.equal(await Task.countDocuments({ masterItem: shared._id }), 1);

    const payroll = await ProjectWorkItem.create({ client: client._id, project: project._id,
      title: 'Payroll', notes: 'Reconcile payroll before posting', weeklyHours: '4 hours', frequency: 'Weekly-Friday' });
    const payrollSchedule = await TaskTemplate.create({ title: payroll.title, client: client._id, project: project._id,
      masterItem: payroll._id, assignees: [employee._id], frequency: 'weekly', weekday: 5, startsOn: new Date('2026-10-01') });
    const timedWithoutFrequency = await ProjectWorkItem.create({ client: client._id, project: project._id,
      title: 'One-time register work', responsibleUser: employee._id, weeklyHours: '45 minutes' });
    const assignedBudget = (await getDay(employee, '2026-10-15')).catalog.find((row) => row.workItemId === String(timedWithoutFrequency._id));
    assert.equal(assignedBudget.hours, 0.75);
    assert.equal(assignedBudget.period, 'daily');
    const rawSchedule = await ProjectWorkItem.create({ client: client._id, project: project._id,
      title: 'Closeout', responsibleUser: employee._id, frequency: 'Monthly', executionDay: '15th of Every Month' });
    const findsSuggestion = async (user, day, id) => (await getDay(user, day)).workItems.find((row) => row.id === String(id)).suggested;
    assert.equal(await findsSuggestion(employee, '2026-10-23', payroll._id), true);
    assert.equal(await findsSuggestion(employee, '2026-10-22', payroll._id), false);
    assert.equal(await findsSuggestion(lead, '2026-10-23', payroll._id), false);
    assert.equal(await findsSuggestion(employee, '2026-10-15', rawSchedule._id), true);
    assert.equal(await findsSuggestion(employee, '2026-10-16', rawSchedule._id), false);
    assert.deepEqual((await getDay(employee, '2026-10-23')).reviewProjects, []);
    assert.ok((await getDay(lead, '2026-10-23')).reviewProjects.includes(daily._id));
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

    const emptyProject = await ClientProject.create({ client: client._id, name: 'Ad hoc work' });
    const emptyDate = '2026-10-28';
    const emptyDay = await getDay(employee, emptyDate);
    const emptyProjectId = emptyDay.projects.find((row) => row.workflowProjectId === String(emptyProject._id))._id;
    await log(employee, emptyDate, [time('Prepare one-off report', 1)], 400);
    const custom = await log(employee, emptyDate, [time('Prepare one-off report', 1, emptyProjectId)]);
    assert.equal(custom.entries[0].title, 'Prepare one-off report');
    assert.equal(custom.entries[0].hours, 1);
    assert.ok(custom.entries[0].workflowTaskId);
    const increased = await log(employee, emptyDate, [{ ...custom.entries[0], hours: 1.5 }], 200, custom.version);
    assert.equal(increased.entries[0].hours, 1.5);
    await log(employee, emptyDate, [{ ...increased.entries[0], hours: 24.01 }], 400, increased.version);
    await request(owner, `/projects/${emptyProjectId}/catalog`, 'POST', { title: 'New predefined task', hours: 1 }, 201);
    const revised = await log(employee, emptyDate, [{ ...increased.entries[0], hours: 0.75 }], 200, increased.version);
    assert.equal(revised.entries[0].hours, 0.75);
    const corrected = await log(employee, emptyDate, [{ ...revised.entries[0], hours: 1.25 }], 200, revised.version);
    assert.equal(corrected.entries[0].hours, 1.25);

    const archivedId = corrected.entries[0].workflowTaskId;
    const archivedStatusPath = `/day/${emptyDate}/members/${employee._id}/entries/${corrected.entries[0]._id}/status`;
    const markedIncomplete = await request(employee, archivedStatusPath, 'PATCH', {
      status: 'incomplete', version: corrected.version, reason: 'Waiting for a statement',
    });
    await request(owner, `/tasks/${archivedId}`, 'DELETE');
    const archivedReport = await request(employee, `/reports?from=${emptyDate}&status=incomplete`);
    assert.equal(archivedReport.submissions[0].entries[0].workflowStatus, 'unavailable');
    assert.equal(archivedReport.submissions[0].entries[0].canUpdateStatus, true);
    const finishArchived = { status: 'complete', version: markedIncomplete.version };
    await request(other, archivedStatusPath, 'PATCH', finishArchived, 403);
    const finished = await request(employee, archivedStatusPath, 'PATCH', finishArchived);
    assert.equal(finished.entry.status, 'complete');
    assert.equal(finished.entry.incompleteReason, undefined);
    assert.equal(finished.entry.hours, 1.25);
    assert.equal(finished.entry.workflowTaskId, archivedId);
    const archived = await Task.findById(archivedId);
    assert.equal(archived.status, 'cancelled');
    assert.ok(archived.deletedAt);
    assert.equal(await Task.countDocuments({ client: client._id, title: corrected.entries[0].title }), 1);
    assert.equal((await request(lead, `/reports?from=${emptyDate}&status=complete`)).submissions[0].entries[0].status, 'complete');

    const leadCatalog = (await getDay(lead, '2026-10-05')).catalog;
    assert.equal(leadCatalog.filter((task) => task.review).length, 3);
    await log(owner, '2026-10-05', [time('Review', 1)], 403);
    await log(lead, '2026-10-05', [time('Review', 0.6), time('Review', 0.41, String(legacyProject))], 400);
    await log(lead, '2026-10-05', [time('Review', 0.6), time('Review', 0.4, String(legacyProject))]);
    await log(lead, '2026-10-06', [time('Review', 1)]);
    assert.equal((await getDay(lead, '2026-10-05')).catalog.find((task) => task.title === 'Month end').remainingHours, 7);

    const reportDate = '2026-11-06';
    const nextDate = '2026-11-07';
    const [earlyMissing, lateMissing, onLeave] = await Promise.all([
      person('Morning member', 'employee'), person('Late member', 'employee'), person('On leave', 'employee'),
    ]);
    const configure = (member, slackUserId, shiftStart, reminderAt, expected = 200) =>
      request(owner, `/users/${member._id}`, 'PATCH', {
        slackUserId, dailyReport: { enabled: true, shiftStart, reminderAt },
      }, expected);
    const savedSettings = await configure(lateMissing, 'U123LATE', '15:00', '15:45');
    assert.deepEqual(savedSettings.dailyReport, { enabled: true, shiftStart: '15:00', reminderAt: '15:45' });
    await configure(lateMissing, 'U123LATE', '15:00', '10:00', 400);
    await configure(earlyMissing, 'U123EARLY', '09:00', '10:00');
    await configure(onLeave, 'U123LEAVE', '09:00', '10:00');
    await setCurrentLeave((await dailyModels()).Leave, String(onLeave._id), shiftDate(reportDate, -1), true);
    const settings = await request(owner, '/users?dailyReport=1');
    assert.equal(settings.find((row) => row._id === String(lateMissing._id)).dailyReport.reminderAt, '15:45');
    assert.equal(settings.find((row) => row._id === String(employee._id)).dailyReport.reminderAt, '15:30');
    await configure(employee, 'U123TEST', '09:00', '10:00');
    await configure(owner, 'U123OWNER', '09:00', '10:00');
    await configure(manager, 'U123MANAGER', '09:00', '10:00');
    await configure(lead, 'U123LEAD', '16:00', '16:00');

    const reportModels = await dailyModels();
    const baseRow = { projectId: daily._id, clientId: String(client._id), projectName: 'Accounting', status: 'incomplete', priority: 'high', hours: 1 };
    await reportModels.Submission.create([
      { _id: `${onLeave._id}:${reportDate}`, memberId: String(onLeave._id), memberName: onLeave.name, date: reportDate,
        entries: [{ ...baseRow, title: 'Incomplete task while on leave' }] },
      { _id: `${manager._id}:${reportDate}`, memberId: String(manager._id), memberName: manager.name, date: reportDate,
        entries: [{ ...baseRow, title: 'Manager-only incomplete task' }] },
      { _id: `${earlyMissing._id}:${nextDate}`, memberId: String(earlyMissing._id), memberName: earlyMissing.name, date: nextDate,
        entries: [{ ...baseRow, title: 'Next day task' }] },
      { _id: `${employee._id}:${reportDate}`, memberId: String(employee._id), memberName: employee.name, date: reportDate,
        entries: [
          { ...baseRow, title: 'Incomplete closing task', incompleteReason: 'Waiting for bank statement' },
          { ...baseRow, title: 'Task pending TL review', workflowStatus: 'pending_review' },
          { ...baseRow, title: 'Completed closing task', status: 'complete' },
        ] },
    ]);
    await reportModels.Member.updateOne({ _id: String(employee._id) }, { $set: { reportFrom: reportDate } });
    process.env.DAILY_WORK_SLACK_TOKEN = 'mock-token';
    delete process.env.DAILY_WORK_SLACK_REPORTS;
    await reportModels.StatusReminder.create({
      _id: 'status-reminder', name: 'Task status reminder', time: '19:00', enabled: true,
      message: 'Team, please update the work status of your tasks on Workflow.',
    });
    const callsBeforeSchedule = calls.length;
    const at = (day, time) => new Date(`${day}T${time}:00+05:30`);
    await runDailyWorkJobs(at(reportDate, '00:00'));
    assert.match(calls.at(-1).text, /No eligible Daily Work submissions to check/);
    await runDailyWorkJobs(at(reportDate, '09:55'));
    assert.equal(calls.length, callsBeforeSchedule + 1);
    await runDailyWorkJobs(at(reportDate, '10:00'));
    await runDailyWorkJobs(at(reportDate, '10:05'));
    assert.equal(calls.length, callsBeforeSchedule + 2);
    assert.doesNotMatch(calls.at(-1).text, /U123OWNER|U123MANAGER/);
    assert.match(calls.at(-1).text, /U123EARLY/);
    assert.match(calls.at(-1).text, /Submitted: 1\/2/);
    assert.doesNotMatch(calls.at(-1).text, /U123LATE|U123LEAVE/);
    await runDailyWorkJobs(at(reportDate, '15:30'));
    assert.equal(calls.length, callsBeforeSchedule + 3);
    assert.match(calls.at(-1).text, /U123LATE/);
    assert.doesNotMatch(calls.at(-1).text, /U123EARLY/);
    await runDailyWorkJobs(at(reportDate, '17:25'));
    assert.equal(calls.length, callsBeforeSchedule + 3);
    await runDailyWorkJobs(at(reportDate, '17:30'));
    assert.equal(calls.length, callsBeforeSchedule + 4);
    assert.match(calls.at(-1).text, /Weekly Submission Report.*2026-11-02 to 2026-11-06/);
    assert.doesNotMatch(calls.at(-1).text, /U123MANAGER|U123LEAVE/);
    assert.match(calls.at(-1).text, /Saved after the deadline: 1\/1/);
    await Promise.all([runDailyWorkJobs(at(reportDate, '18:00')), runDailyWorkJobs(at(reportDate, '18:00'))]);
    await runDailyWorkJobs(at(reportDate, '18:05'));
    await runDailyWorkJobs(at(reportDate, '19:00'));
    assert.equal(calls.length, callsBeforeSchedule + 5);
    assert.equal(calls.at(-1).channel, 'mock-channel');
    assert.equal(calls.at(-1).thread_ts, undefined);
    assert.equal(calls.at(-1).text, '<!channel> Team, please update the work status of your tasks on Workflow.');
    await runDailyWorkJobs(at(nextDate, '00:00'));
    await runDailyWorkJobs(at(nextDate, '00:15'));
    assert.equal(calls.length, callsBeforeSchedule + 6);
    assert.match(calls.at(-1).text, /Incomplete Tasks Report/);
    assert.doesNotMatch(calls.at(-1).text, /U123MANAGER|Manager-only incomplete task|U123LEAVE|Incomplete task while on leave/);
    assert.match(calls.at(-1).text, /Date: 2026-11-06/);
    assert.match(calls.at(-1).text, /Employee: <@U123TEST>/);
    assert.match(calls.at(-1).text, /Reason: Waiting for bank statement/);
    assert.doesNotMatch(calls.at(-1).text, /Next day task|Task pending TL review|Completed closing task/);
    for (const weekendTime of ['01:00', '10:00', '15:30', '17:30', '18:00']) {
      await runDailyWorkJobs(at(nextDate, weekendTime));
    }
    assert.equal(calls.length, callsBeforeSchedule + 6);
    await runDailyWorkJobs(at(shiftDate(nextDate, 1), '00:00'));
    assert.equal(calls.length, callsBeforeSchedule + 7);
    assert.match(calls.at(-1).text, /Date: 2026-11-07/);
    for (const { text } of calls.slice(callsBeforeSchedule)) assert.match(text, /^<!channel> /);

    const completedDate = shiftDate(reportDate, 7);
    await reportModels.Submission.create([employee, earlyMissing].map((member) => ({
      _id: `${member._id}:${completedDate}`, memberId: String(member._id), memberName: member.name, date: completedDate,
      entries: [{ ...baseRow, title: 'Submitted on time', status: 'complete' }],
    })));
    await setCurrentLeave(reportModels.Leave, String(lateMissing._id), completedDate, true);
    const allSubmitted = '<!channel> :confetti_ball: *Excellent!* All employees have submitted their work details.';
    await runDailyWorkJobs(at(completedDate, '10:00'));
    assert.equal(calls.at(-1).text, allSubmitted);
    await runDailyWorkJobs(at(completedDate, '15:30'));
    assert.match(calls.at(-1).text, /No employees were expected to submit at this check/);
    const missingSlackPath = `/missing/${reportDate}/slack`;
    await request(lead, missingSlackPath, 'POST', undefined, 403);
    await request(employee, missingSlackPath, 'POST', undefined, 403);
    await request(employee, missingSlackPath, 'GET', undefined, 403);
    const countBeforePreview = calls.length;
    const preview = await request(owner, missingSlackPath);
    assert.equal(calls.length, countBeforePreview);
    assert.equal(preview.slackEnabled, true);
    assert.equal(preview.missing.length, 5);
    assert.ok(preview.missing.some(({ id }) => id === String(other._id)));
    assert.ok(preview.missing.some(({ id }) => id === String(earlyMissing._id)));
    await request(owner, missingSlackPath, 'POST', { previewVersion: 'old' }, 409);
    assert.equal(calls.length, countBeforePreview);
    const manualReport = await request(owner, missingSlackPath, 'POST', { previewVersion: preview.previewVersion });
    assert.equal(manualReport.missing, 5);
    assert.match(calls.at(-1).text, /^<!channel> :clipboard:/);
    assert.match(calls.at(-1).text, /<@U123EARLY>/);
    assert.match(calls.at(-1).text, /<@U123LATE>/);
    assert.doesNotMatch(calls.at(-1).text, /U123OWNER|U123MANAGER|U123LEAVE/);
    process.env.DAILY_WORK_SLACK_REPORTS = 'false';
    const callsBeforeCustom = calls.length;

    const settingsPath = '/settings/reminders';
    const { reminders } = await request(owner, settingsPath);
    const defaultReminder = reminders[0];
    assert.equal(defaultReminder.time, '18:00');
    await request(lead, settingsPath, 'GET', undefined, 403);
    await request(employee, settingsPath, 'POST', defaultReminder, 403);
    await request(manager, `${settingsPath}/${defaultReminder._id}`, 'PUT', defaultReminder, 403);
    await request(owner, settingsPath, 'POST', { ...defaultReminder, time: '25:00' }, 400);
    await request(owner, `${settingsPath}/${defaultReminder._id}`, 'PUT', { ...defaultReminder, enabled: false });
    const savedReminder = await request(owner, settingsPath, 'POST', {
      name: 'Close notes', time: '23:58', enabled: true, notifyChannel: false, message: 'Update A & B <notes>.',
    }, 201);
    const customReminder = savedReminder.reminders.find((row) => row.name === 'Close notes');
    assert.equal(customReminder.time, '23:58');
    const reminderDay = shiftDate(nextDate, 2);
    await runDailyWorkJobs(at(reminderDay, '18:35'));
    assert.equal(calls.length, callsBeforeCustom);
    await runDailyWorkJobs(at(shiftDate(reminderDay, 1), '00:00'));
    await runDailyWorkJobs(at(shiftDate(reminderDay, 1), '00:05'));
    assert.equal(calls.length, callsBeforeCustom + 1);
    assert.equal(calls.at(-1).text, '<!channel> Update A &amp; B &lt;notes&gt;.');
    await request(owner, `${settingsPath}/${customReminder._id}`, 'PUT', {
      ...customReminder, time: '18:40', message: 'Update your close notes.',
    });
    await runDailyWorkJobs(at(shiftDate(reminderDay, 1), '18:40'));
    assert.equal(calls.length, callsBeforeCustom + 2);
    assert.equal(calls.at(-1).text, '<!channel> Update your close notes.');
    const deliveryKey = `${customReminder._id}:${clock().date}`;
    const attempt = new Date();
    await reportModels.Report.create({ _id: deliveryKey, state: 'sent', startedAt: attempt });
    const deliverySettings = await request(owner, settingsPath);
    assert.deepEqual(deliverySettings.reminders.find((row) => row._id === customReminder._id).delivery,
      { state: 'sent', startedAt: attempt.toISOString() });
    const moved = await request(owner, `${settingsPath}/${customReminder._id}`, 'PUT', { ...customReminder, time: '19:00' });
    assert.deepEqual(moved.reminders.find((row) => row._id === customReminder._id).delivery,
      { state: 'sent', startedAt: attempt.toISOString() });

    const customPath = `${settingsPath}/${customReminder._id}`;
    const defaultPath = `${settingsPath}/${defaultReminder._id}`;
    await request(lead, customPath, 'DELETE', undefined, 403);
    assert.ok(!(await request(owner, customPath, 'DELETE')).reminders.some((row) => row._id === customReminder._id));
    await request(owner, customPath, 'PUT', customReminder, 404);
    assert.ok(await reportModels.Report.exists({ _id: deliveryKey }));
    await reportModels.StatusReminder.deleteOne({ _id: defaultReminder._id });
    assert.deepEqual((await request(owner, defaultPath, 'DELETE')).reminders, []);
    await request(owner, defaultPath, 'PUT', defaultReminder, 409);
    assert.deepEqual((await request(owner, settingsPath)).reminders, []);
    await runDailyWorkJobs(at(shiftDate(reminderDay, 2), '18:35'));
    await runDailyWorkJobs(at(shiftDate(reminderDay, 2), '19:00'));
    assert.equal(calls.length, callsBeforeCustom + 2);

    const dailyBeforeDelete = await request(employee, `/day/${reportDate}`);
    assert.ok(dailyBeforeDelete.projects.some((row) => row._id === daily._id));
    await request(owner, `/clients/${client._id}/projects/${project._id}`, 'DELETE');
    const entryAfterDelete = await request(employee, `/day/${reportDate}`);
    assert.ok(!entryAfterDelete.projects.some((row) => row._id === daily._id));
    assert.deepEqual(entryAfterDelete.submission.entries.map((row) => row._id),
      dailyBeforeDelete.submission.entries.map((row) => row._id));
    await request(owner, `/projects/${daily._id}`, 'PATCH', { archived: false }, 400);
    await request(employee, `/day/${reportDate}`, 'PUT', {
      version: entryAfterDelete.submission.version,
      entries: [{ projectId: daily._id, title: 'New entry after removal', status: 'incomplete', priority: 'normal', hours: 1 }],
    }, 400);
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

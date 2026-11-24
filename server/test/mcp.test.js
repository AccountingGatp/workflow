import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('Workflow MCP negotiates scoped OAuth connections and enforces task permissions', async () => {
  const db = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.WORKFLOW_MCP_ORIGIN = origin;
  try {
    const { default: app, handleErrors } = await import('../src/app.js');
    const { JWT_SECRET } = await import('../src/middleware/auth.js');
    const { dailyModels } = await import('../src/daily-work/models.js');
    const { User, Client, ClientProject, ProjectWorkItem, Task, TaskTemplate } = await import('../src/models/index.js');
    await mongoose.connect(db.getUri());
    handleErrors(app);
    server.on('request', app);
    const fixture = await Client.create({ name: 'Fixture' });
    const project = await ClientProject.create({ client: fixture._id, name: 'Sample project' });
    const [owner, hr, employee, manager, lead] = await User.create([
      { email: 'owner@test.example', name: 'Owner', role: 'super_admin' },
      { email: 'hr@test.example', name: 'HR', role: 'hr' },
      { email: 'employee@test.example', name: 'Employee', role: 'employee' },
      { email: 'manager@test.example', name: 'Manager', role: 'manager' },
      { email: 'lead@test.example', name: 'Team Lead', role: 'admin' },
    ]);
    const credential = (person) => ({ authorization: 'Bearer ' + jwt.sign({ sub: String(person._id) }, JWT_SECRET, { expiresIn: '1h' }) });
    const resource = origin + '/api/mcp';
    const metadataPath = '/.well-known/oauth-protected-resource/api/mcp';
    const supported = await (await fetch(origin + metadataPath)).json();
    assert.equal(supported.resource, resource);
    const auth = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
    const registerClient = (redirect, method = 'none') => fetch(auth.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: method }),
    });
    assert.equal((await registerClient('https://chatgpt.com/connector_platform_oauth_redirect')).status, 201);
    const redirect = 'https://claude.ai/api/mcp/auth_callback';
    assert.equal((await registerClient(redirect, 'client_secret_post')).status, 201);
    const registered = await registerClient(redirect);
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    assert.equal((await registerClient(redirect + '?next=unapproved')).status, 400);
    assert.equal((await registerClient('https://claude.ai.unapproved.example/api/mcp/auth_callback')).status, 400);

    async function requestApproval() {
      const verifier = randomBytes(32).toString('base64url');
      const params = new URLSearchParams({
        response_type: 'code', client_id, redirect_uri: redirect, scope: 'workflow:read workflow:write workflow:delete',
        state: 'fixture-state', resource, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      });
      const authResponse = await fetch(auth.authorization_endpoint + '?' + params, { redirect: 'manual' });
      assert.equal(authResponse.status, 303);
      const signIn = new URL(authResponse.headers.get('location'), origin);
      const requestId = signIn.searchParams.get('request');
      return { verifier, endpoint: origin + '/api/mcp-connections/consent/' + requestId };
    }
    const postToken = (fields) => fetch(auth.token_endpoint, {
      method: 'POST', body: new URLSearchParams({ client_id, resource, ...fields }),
    });
    async function approve(person, access, expected = 200, allowDelete = false) {
      const { verifier, endpoint } = await requestApproval();
      const consent = await fetch(endpoint, { headers: credential(person) });
      const options = await consent.json();
      assert.equal(options.allowWrite, person.role !== 'hr');
      assert.equal(options.allowDelete, person.role === 'super_admin');
      const response = await fetch(endpoint, {
        method: 'POST', headers: { ...credential(person), 'content-type': 'application/json' },
        body: JSON.stringify({ access, allowDelete }),
      });
      assert.equal(response.status, expected);
      if (expected !== 200) return;
      const { returnTo } = await response.json();
      const callback = new URL(returnTo);
      assert.equal(callback.searchParams.get('state'), 'fixture-state');
      const code = callback.searchParams.get('code');
      const fields = { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier };
      assert.equal((await postToken({ ...fields, code_verifier: randomBytes(32).toString('base64url') })).status, 400);
      const exchange = await postToken(fields);
      assert.equal(exchange.status, 200);
      assert.equal((await postToken(fields)).status, 400);
      return exchange.json();
    }
    async function connect(token) {
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: token ? { headers: { authorization: 'Bearer ' + token } } : {},
      });
      const client = new McpClient({ name: 'Workflow integration test', version: '1.0' });
      await client.connect(transport);
      return client;
    }

    const publicClient = await connect();
    const available = await publicClient.listTools();
    assert.ok(available.tools.some((tool) => tool.name === 'delete_task' && tool.annotations.destructiveHint));
    const denied = await publicClient.callTool({ name: 'list_projects', arguments: {} });
    assert.ok(denied.isError && denied._meta['mcp/www_authenticate'][0].includes(metadataPath), JSON.stringify(denied));
    await publicClient.close();

    const { Submission } = await dailyModels();
    await Submission.create({
      _id: String(hr._id) + ':2026-11-23', date: '2026-11-23', memberId: String(hr._id), memberName: hr.name,
      entries: [{
        projectId: String(project._id), clientId: String(fixture._id), projectName: project.name,
        title: 'Pending check', hours: 2, priority: 'normal', status: 'incomplete', incompleteReason: 'Waiting for a statement',
      }],
    });
    const read = await approve(owner, 'read');
    assert.equal(read.scope, 'workflow:read');
    const readClient = await connect(read.access_token);
    const projects = await readClient.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(projects.structuredContent.projects[0].name, project.name);
    const report = await readClient.callTool({ name: 'list_daily_work', arguments: { date: '2026-11-23', status: 'incomplete' } });
    assert.equal(report.structuredContent.submissions[0].entries[0].incompleteReason, 'Waiting for a statement');
    const draft = { title: 'MCP task', client: String(fixture._id), project: String(project._id), dueDate: '2026-11-23' };
    const writeDenied = await readClient.callTool({ name: 'create_task', arguments: draft });
    assert.equal(writeDenied.isError, true);
    assert.ok((await readClient.callTool({ name: 'create_project', arguments: { name: 'Blocked project' } })).isError);
    assert.equal(await Task.countDocuments(), 0);
    await readClient.close();
    assert.equal((await postToken({ grant_type: 'refresh_token', refresh_token: read.refresh_token, scope: 'workflow:read workflow:write' })).status, 400);

    const connectionsPath = origin + '/api/mcp-connections';
    const { endpoint } = await requestApproval();
    for (const person of [hr, employee]) {
      assert.equal((await fetch(connectionsPath, { headers: credential(person) })).status, 403);
      assert.equal((await fetch(endpoint, { headers: credential(person) })).status, 403);
      assert.equal((await fetch(endpoint, {
        method: 'POST', headers: { ...credential(person), 'content-type': 'application/json' },
        body: JSON.stringify({ access: 'read' }),
      })).status, 403);
    }
    for (const person of [manager, lead]) {
      assert.equal((await fetch(connectionsPath, { headers: credential(person) })).status, 200);
      const consent = await fetch(endpoint, { headers: credential(person) });
      assert.equal(consent.status, 200);
      const permissions = await consent.json();
      assert.equal(permissions.allowWrite, true);
      assert.equal(permissions.allowDelete, false);
    }
    const leadGrant = await approve(lead, 'read');
    const connectedLead = await connect(leadGrant.access_token);
    await connectedLead.close();
    await User.updateOne({ _id: lead._id }, { role: 'employee' });
    await assert.rejects(() => connect(leadGrant.access_token), /401|Unauthorized|expired|revoked/);
    assert.equal((await postToken({ grant_type: 'refresh_token', refresh_token: leadGrant.refresh_token })).status, 400);
    const write = await approve(owner, 'write');
    const writer = await connect(write.access_token);
    const projectResult = await writer.callTool({ name: 'create_project', arguments: { name: 'Payroll fixture' } });
    assert.ok(!projectResult.isError, JSON.stringify(projectResult));
    const { _id: payrollProject, client: payrollClient } = projectResult.structuredContent.project;
    const payroll = { project: payrollProject, client: payrollClient };
    const master = await writer.callTool({ name: 'create_master_task', arguments: {
      ...payroll, title: 'Check payroll', frequency: 'Weekly', weeklyHours: '3 h weekly',
    } });
    const masterId = master.structuredContent.masterTask._id;
    assert.equal(master.structuredContent.masterTask.responsibleUser, undefined);
    const args = { ...payroll, title: 'Check payroll', masterItem: masterId, frequency: 'weekly', weekday: 1, startsOn: '2026-12-07' };
    assert.ok((await writer.callTool({ name: 'create_recurring_task', arguments: { ...args, weekday: undefined } })).isError);
    const schedule = await writer.callTool({ name: 'create_recurring_task', arguments: args });
    assert.ok(!schedule.isError, JSON.stringify(schedule));
    const templateId = schedule.structuredContent.template._id;
    assert.deepEqual(schedule.structuredContent.template.assignees, []);
    assert.equal(String((await ProjectWorkItem.findById(masterId)).scheduledTemplate), templateId);
    assert.ok(await Task.exists({ template: templateId, masterItem: masterId }));
    assert.ok((await writer.callTool({ name: 'create_recurring_task', arguments: args })).isError);
    assert.equal(await TaskTemplate.countDocuments({ masterItem: masterId }), 1);

    const created = await writer.callTool({ name: 'create_task', arguments: draft });
    assert.ok(!created.isError, JSON.stringify(created));
    const taskId = created.structuredContent.task._id;
    const listed = await writer.callTool({ name: 'list_tasks', arguments: { from: '2026-11-23', to: '2026-11-23' } });
    assert.equal(listed.structuredContent.total, 1);
    const updated = await writer.callTool({ name: 'update_task', arguments: { taskId, status: 'done' } });
    assert.equal(updated.structuredContent.task.status, 'done');
    assert.equal((await writer.callTool({ name: 'delete_task', arguments: { taskId } })).isError, true);
    const template = await TaskTemplate.create({ title: 'Recurring fixture', client: fixture._id, project: project._id, frequency: 'daily' });
    const occurrence = await Task.create({ title: template.title, client: fixture._id, project: project._id,
      template: template._id, dueDate: new Date('2026-11-22T06:30:00Z'), status: 'done' });
    const previous = await Submission.create({
      _id: String(hr._id) + ':2026-11-22', date: '2026-11-22', memberId: String(hr._id), memberName: hr.name,
      delivery: 'skipped', entries: [{ projectId: String(project._id), clientId: String(fixture._id), projectName: project.name,
        title: occurrence.title, workflowTaskId: String(occurrence._id), hours: 2, priority: 'normal', status: 'complete' }],
    });
    const other = await Submission.create({
      _id: String(owner._id) + ':2026-11-22', date: '2026-11-22', memberId: String(owner._id), memberName: owner.name,
      entries: previous.entries,
    });
    const selection = { memberIds: [String(hr._id)], from: '2026-11-01', to: '2026-11-22' };
    const preview = async (client) => client.callTool({ name: 'preview_daily_work_cleanup', arguments: selection });
    const remove = async (client, token) => client.callTool({
      name: 'delete_daily_work_activity', arguments: { ...selection, confirmationToken: token },
    });
    const reviewed = (await preview(writer)).structuredContent;
    assert.equal(reviewed.submissionCount, 1);
    assert.equal(reviewed.entryCount, 1);
    assert.equal((await remove(writer, reviewed.confirmationToken)).isError, true);
    await writer.close();

    const destructive = await approve(owner, 'read', 200, true);
    assert.equal(destructive.scope, 'workflow:read workflow:delete');
    const deleter = await connect(destructive.access_token);
    await Submission.updateOne({ _id: previous._id }, { $set: { delivery: 'sending' } });
    assert.equal((await remove(deleter, reviewed.confirmationToken)).isError, true);
    const sending = (await preview(deleter)).structuredContent;
    assert.equal(sending.sendingCount, 1);
    assert.equal((await remove(deleter, sending.confirmationToken)).isError, true);
    await Submission.updateOne({ _id: previous._id }, { $set: { delivery: 'sent', slackTs: 'fixture-ts' } });
    const confirmed = (await preview(deleter)).structuredContent;
    const result = await remove(deleter, confirmed.confirmationToken);
    assert.equal(result.structuredContent.deletedSubmissions, 1, JSON.stringify(result));
    assert.equal(await Submission.exists({ _id: previous._id }), null);
    assert.ok(await Submission.exists({ _id: other._id }));
    assert.ok(await Submission.exists({ _id: String(hr._id) + ':2026-11-23' }));
    assert.equal((await Task.findById(occurrence._id)).status, 'done');
    assert.ok(await TaskTemplate.findById(template._id));
    const { SubmissionArchive } = await dailyModels();
    const archived = await SubmissionArchive.findOne({ cleanupId: result.structuredContent.cleanupId }).lean();
    assert.equal(archived.submission.slackTs, 'fixture-ts');
    assert.equal((await remove(deleter, confirmed.confirmationToken)).isError, true);

    const removed = await deleter.callTool({ name: 'delete_task', arguments: { taskId } });
    assert.equal(removed.structuredContent.ok, true);
    assert.ok((await Task.findById(taskId)).deletedAt);
    await User.updateOne({ _id: owner._id }, { role: 'manager' });
    assert.equal((await deleter.callTool({ name: 'delete_task', arguments: { taskId: String(occurrence._id) } })).isError, true);
    await User.updateOne({ _id: owner._id }, { role: 'super_admin' });
    await deleter.close();

    const refresh = await postToken({ grant_type: 'refresh_token', refresh_token: write.refresh_token });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    assert.equal((await postToken({ grant_type: 'refresh_token', refresh_token: write.refresh_token })).status, 400);
    const connections = await (await fetch(origin + '/api/mcp-connections', { headers: credential(owner) })).json();
    const grant = connections.grants.find((row) => row.scopes.includes('workflow:write'));
    const revoked = await fetch(origin + '/api/mcp-connections/' + grant._id, { method: 'DELETE', headers: credential(owner) });
    assert.equal(revoked.status, 200);
    await assert.rejects(() => connect(rotated.access_token), /401|Unauthorized|expired|revoked/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await db.stop();
  }
});

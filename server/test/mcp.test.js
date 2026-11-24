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
    const { User, Client, ClientProject, Task } = await import('../src/models/index.js');
    await mongoose.connect(db.getUri());
    handleErrors(app);
    server.on('request', app);
    const fixture = await Client.create({ name: 'Fixture' });
    const project = await ClientProject.create({ client: fixture._id, name: 'Sample project' });
    const [owner, hr] = await User.create([
      { email: 'owner@test.example', name: 'Owner', role: 'super_admin' },
      { email: 'hr@test.example', name: 'HR', role: 'hr' },
    ]);
    const credential = (person) => ({ authorization: 'Bearer ' + jwt.sign({ sub: String(person._id) }, JWT_SECRET, { expiresIn: '1h' }) });
    const resource = origin + '/api/mcp';
    const metadataPath = '/.well-known/oauth-protected-resource/api/mcp';
    const supported = await (await fetch(origin + metadataPath)).json();
    assert.equal(supported.resource, resource);
    const auth = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const registered = await fetch(auth.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    const registrationDenied = await fetch(auth.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://unapproved.example/callback'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(registrationDenied.status, 400);

    async function requestApproval() {
      const verifier = randomBytes(32).toString('base64url');
      const params = new URLSearchParams({
        response_type: 'code', client_id, redirect_uri: redirect, scope: 'workflow:read workflow:write',
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
    async function approve(person, access, expected = 200) {
      const { verifier, endpoint } = await requestApproval();
      const consent = await fetch(endpoint, { headers: credential(person) });
      assert.equal((await consent.json()).allowWrite, person.role !== 'hr');
      const response = await fetch(endpoint, {
        method: 'POST', headers: { ...credential(person), 'content-type': 'application/json' },
        body: JSON.stringify({ access }),
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
    assert.equal(await Task.countDocuments(), 0);
    await readClient.close();
    assert.equal((await postToken({ grant_type: 'refresh_token', refresh_token: read.refresh_token, scope: 'workflow:read workflow:write' })).status, 400);

    await approve(hr, 'write', 403);
    const write = await approve(owner, 'write');
    const writer = await connect(write.access_token);
    const created = await writer.callTool({ name: 'create_task', arguments: draft });
    assert.ok(!created.isError, JSON.stringify(created));
    const taskId = created.structuredContent.task._id;
    const listed = await writer.callTool({ name: 'list_tasks', arguments: { from: '2026-11-23', to: '2026-11-23' } });
    assert.equal(listed.structuredContent.total, 1);
    const updated = await writer.callTool({ name: 'update_task', arguments: { taskId, status: 'done' } });
    assert.equal(updated.structuredContent.task.status, 'done');
    const removed = await writer.callTool({ name: 'delete_task', arguments: { taskId } });
    assert.equal(removed.structuredContent.ok, true);
    assert.ok((await Task.findById(taskId)).deletedAt);
    await writer.close();

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

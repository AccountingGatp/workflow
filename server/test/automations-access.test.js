import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app, { handleErrors } from '../src/app.js';
import { JWT_SECRET } from '../src/middleware/auth.js';
import { Client, ClientProject, User } from '../src/models/index.js';

test('all signed-in roles can use the catalog and only management roles can change it', async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1,
    args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
  } });
  let server;
  try {
    await mongoose.connect(db.getUri());
    handleErrors(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}/api/automations`;
    const client = await Client.create({ name: 'Private client' });
    const [project, unlisted] = await ClientProject.create([
      { client: client._id, name: 'Tools' }, { client: client._id, name: 'Unlisted project' },
    ]);
    const people = await User.create(['admin', 'manager', 'super_admin', 'employee', 'hr']
      .map((role) => ({ name: role, role, email: role + '@example.test' })));
    const [lead, manager, owner, employee, hr] = people;
    const request = (user, path = '', method = 'GET', data) => fetch(endpoint + path, {
      method,
      headers: { 'content-type': 'application/json',
        ...(user && { authorization: 'Bearer ' + jwt.sign({ sub: String(user._id) }, JWT_SECRET) }) },
      body: data && JSON.stringify(data),
    });
    const base = '/' + project._id;
    const links = base + '/links';
    const card = { name: 'Reconciliation', url: 'https://example.test/reconciliation' };

    assert.equal((await request(null)).status, 401);
    assert.equal((await request(lead, base, 'PUT')).status, 200);
    assert.equal((await request(manager, links, 'POST', card)).status, 201);
    const catalog = await (await request(owner)).json();
    const saved = catalog.find((row) => row.id === String(project._id)).links[0];
    const editPath = links + '/' + saved._id;
    assert.equal((await request(lead, editPath, 'PATCH', { ...card, name: 'Bank reconciliation' })).status, 200);
    for (const user of [employee, hr]) {
      const visible = await (await request(user)).json();
      assert.deepEqual(visible.map((row) => row.id), [String(project._id)]);
      assert.equal(visible[0].links[0].name, 'Bank reconciliation');
      assert.equal(visible[0].canEdit, false);
      assert.equal((await request(user, '/' + unlisted._id, 'PUT')).status, 403);
      assert.equal((await request(user, links, 'POST', card)).status, 403);
      assert.equal((await request(user, editPath, 'PATCH', card)).status, 403);
    }
    assert.equal((await request(owner, '/' + unlisted._id, 'PUT')).status, 200);
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await mongoose.disconnect();
    await db.stop();
  }
});

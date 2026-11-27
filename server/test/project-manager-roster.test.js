import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, ClientProject } from '../src/models/index.js';
import { importProjectManagerRoster } from '../src/project-manager-roster.js';

test('imports the confirmed manager names by project ID and preserves later edits', async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1,
    args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
  } });
  try {
    await mongoose.connect(db.getUri());
    const client = await Client.create({ name: 'Fixture client' });
    const rows = await ClientProject.create([
      { _id: '6afff704dd2acbc38db65bce', name: '480NE30ST1207 LLC', client: client._id },
      { _id: '6afff706dd2acbc38db65be4', name: 'Covenant Women’s Health PLLC', client: client._id },
      { name: 'Training', client: client._id },
      { _id: '6afff709dd2acbc38db65c1a', name: 'Internal Accounting', client: client._id },
      { _id: '6b03bc7e70f7967e19492739', name: 'Internal Accounting',
        client: (await Client.create({ name: 'Second workspace' }))._id },
    ]);
    assert.equal(await importProjectManagerRoster(), 3);
    assert.deepEqual((await ClientProject.findById(rows[0]._id).lean()).projectManager, { name: 'Palak' });
    assert.deepEqual((await ClientProject.findById(rows[1]._id).lean()).projectManager, { name: 'Hitesh' });
    assert.equal((await ClientProject.findById(rows[2]._id).lean()).projectManager, undefined);
    assert.equal((await ClientProject.findById(rows[3]._id).lean()).projectManager.name, 'Palak');
    assert.equal((await ClientProject.findById(rows[4]._id).lean()).projectManager, undefined);
    await ClientProject.updateOne({ _id: rows[0]._id }, { $set: { projectManager: null } });
    assert.equal(await importProjectManagerRoster(), 0);
    assert.equal((await ClientProject.findById(rows[0]._id).lean()).projectManager, null);
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
});

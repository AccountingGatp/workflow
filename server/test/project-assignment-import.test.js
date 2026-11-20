import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, ClientPermission, ClientProject, ProjectPermission, User } from '../src/models/index.js';
import { importProjectAssignments } from '../src/import-project-assignments.js';

test('bulk project assignments preserve existing access and skip unclear names', async () => {
  const db = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
  });
  try {
    await mongoose.connect(db.getUri());
    await ProjectPermission.init();
    const employee = await User.create({
      name: 'Example Employee', email: 'employee@test.example', role: 'employee', active: true, passwordHash: 'fixture',
    });
    const [first, second] = await Client.create([{ name: 'First Test Client' }, { name: 'Second Test Client' }]);
    const [existing, newProject] = await ClientProject.create([
      { name: 'Already Accessible', client: first._id },
      { name: 'New Access', client: second._id },
      { name: 'Duplicated', client: second._id },
      { name: 'Alternative Name', client: second._id },
    ]);
    await ClientPermission.create({ user: employee._id, client: existing.client });
    const input = JSON.stringify([
      { person: ['Example Employee'], projects: [
        ['Already Accessible'], ['New Access'], ['Duplicated', 'Alternative Name'], ['Missing Project'],
      ] },
      { person: ['Unknown Employee'], projects: [['New Access']] },
    ]);
    const attempts = await Promise.all([importProjectAssignments(input), importProjectAssignments(input)]);
    assert.deepEqual(attempts.filter(Boolean), [{ added: 1, existing: 1, unresolved: [
      { person: 1, project: 3, reason: 'multiple projects' },
      { person: 1, project: 4, reason: 'project missing' },
      { person: 2, reason: 'person missing' },
    ] }]);
    const grants = await ProjectPermission.find({ user: employee._id }).lean();
    assert.deepEqual(grants.map(({ project }) => String(project)), [String(newProject._id)]);
    assert.equal(await ClientPermission.countDocuments({ user: employee._id }), 1);
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, ClientProject, ProjectWorkItem, Task, TaskTemplate, User } from '../src/models/index.js';
import { detachBluntdRecurringLinks } from '../src/detach-bluntd-recurring-links.js';

test('detaching the old Bluntd schedules preserves the master catalog and historical occurrences', async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1,
    args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
  } });
  try {
    await mongoose.connect(db.getUri());
    const client = await Client.create({ name: 'Cody' });
    const project = await ClientProject.create({ _id: '6aec5d52b35e33f721f6fd12', name: 'Bluntd', client: client._id });
    const sathya = await User.create({ name: 'Sathya Priya', email: 'sathya.p@gatpsolutions.com' });
    const context = { client: client._id, project: project._id };
    const schedule = { ...context, frequency: 'daily', startsOn: new Date('2026-11-13') };
    const master = await ProjectWorkItem.create({
      ...context, _id: '6aec726ab35e33f721f8afae', title: 'Mail Checking', frequency: 'Daily',
      scheduledTemplate: '6aec726cb35e33f721f8afca', responsibleUser: sathya._id, responsible: sathya.name,
    });
    const template = await TaskTemplate.create({
      ...schedule, _id: master.scheduledTemplate, title: master.title, masterItem: master._id,
      active: true, owner: sathya._id, assignees: [sathya._id],
    });
    const occurrence = await Task.create({
      ...context, title: master.title, masterItem: master._id, template: template._id,
      dueDate: '2026-11-25', assignees: [sathya._id], status: 'done',
    });
    const unrelated = await TaskTemplate.create({ ...schedule, title: 'Unrelated recurring work', active: true });
    assert.equal(await detachBluntdRecurringLinks(), 1);
    const saved = await ProjectWorkItem.findById(master._id).lean();
    assert.equal(saved.scheduledTemplate, undefined);
    assert.equal(saved.responsibleUser, undefined);
    assert.equal(saved.responsible, sathya.name);
    assert.equal(saved.frequency, 'Daily');
    const detached = await TaskTemplate.findById(template._id).lean();
    assert.equal(detached.active, false);
    assert.equal(detached.masterItem, undefined);
    assert.equal(detached.owner, undefined);
    assert.deepEqual(detached.assignees, []);
    assert.equal((await Task.findById(occurrence._id)).status, 'done');
    assert.equal((await TaskTemplate.findById(unrelated._id)).active, true);
    assert.equal(await detachBluntdRecurringLinks(), null);
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
});

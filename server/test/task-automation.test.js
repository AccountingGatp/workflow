import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Client, ClientProject, ProjectWorkItem } from '../src/models/index.js';
import { importTaskAutomation } from '../src/import-task-automation.js';
import { automationByWorkItem } from '../src/services/task-automation.js';
import { dailySubmissionText } from '../src/daily-work/slack.js';

test('only explicit automation values on matching saved tasks are imported and shown in Slack', async () => {
  const db = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'] },
  });
  try {
    await mongoose.connect(db.getUri());
    const client = await Client.create({ name: 'Test Client' });
    const project = await ClientProject.create({ name: 'Test Project', client: client._id });
    const other = await ClientProject.create({ name: 'Other Project', client: client._id });
    const add = (title, extra = {}) => ProjectWorkItem.create({ client: client._id, project: project._id, title, ...extra });
    const items = await Promise.all([
      add('Automated bookkeeping'), add('Manual review'), add('Blank in sheet', { automated: true }),
      add('Cleared by lead', { automationStatus: null }), add('Missing here', { project: other._id }),
    ]);
    const input = JSON.stringify([{ projects: ['Sheet Alias', 'Test Project'], tasks: [
      { title: 'Automated bookkeeping', automated: true }, { title: 'Manual review', automated: false },
      { title: 'Cleared by lead', automated: true }, { title: 'Missing here', automated: false },
    ] }]);
    assert.deepEqual(await importTaskAutomation(input), {
      yes: 1, no: 1, alreadySet: 1, unresolved: [[1, 4, 'missing']],
    });
    assert.equal(await importTaskAutomation(input), null);
    const stored = await ProjectWorkItem.find().select('automationStatus').lean();
    const status = new Map(stored.map(({ _id, automationStatus }) => [String(_id), automationStatus]));
    assert.deepEqual(items.map(({ _id }) => status.get(String(_id))), [true, false, undefined, null, undefined]);
    const entries = items.slice(0, 4).map(({ _id, title }) => ({
      projectName: project.name, title, workItemId: String(_id), hours: 1, priority: 'normal',
    }));
    entries.push({ ...entries[0], workItemId: undefined, note: 'Example note' });
    const submission = { memberName: 'Test Employee', date: '2026-11-23', entries };
    const workItems = await automationByWorkItem([submission]);
    const slack = dailySubmissionText(submission, undefined, false, workItems);
    assert.match(slack, /^   Task 1: Automated bookkeeping \(1h\) - Priority: Medium - Y$/m);
    assert.match(slack, /^   Task 2: Manual review \(1h\) - Priority: Medium - N$/m);
    assert.match(slack, /^   Task 3: Blank in sheet \(1h\) - Priority: Medium - A$/m);
    assert.match(slack, /^   Task 4: Cleared by lead \(1h\) - Priority: Medium - A$/m);
    assert.match(slack, /^   Task 5: Automated bookkeeping \(1h\) - Priority: Medium\n      Note: Example note$/m);
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
});

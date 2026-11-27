import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AutomationGroup, Client, ClientProject } from '../src/models/index.js';
import { seedAutomationCatalog } from '../src/seed-automation-catalog.js';

test('adds Hamilton and LXP links once and preserves manually added cards', async () => {
  const db = await MongoMemoryReplSet.create({ replSet: { count: 1,
    args: ['--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
  } });
  try {
    await mongoose.connect(db.getUri());
    const client = await Client.create({ name: 'Fixture client' });
    const [hamilton, lxp] = await ClientProject.create([
      { _id: '6afff707dd2acbc38db65bf4', name: 'Hamilton Place Apartments', client: client._id },
      { _id: '6affec83763f1cacbcc36719', name: 'LXP Enterprises LLC', client: client._id },
    ]);
    await AutomationGroup.create({ _id: hamilton._id, links: [
      { name: 'Custom payroll name', url: 'https://hamilton-payroll.vercel.app/' },
      { name: 'Existing card', url: 'https://example.test/' },
    ] });
    await seedAutomationCatalog();
    const saved = await AutomationGroup.findById(hamilton._id);
    assert.equal(saved.links.length, 6);
    assert.equal(saved.links[0].name, 'Custom payroll name');
    assert.equal(saved.links[1].name, 'Existing card');
    assert.equal((await AutomationGroup.findById(lxp._id)).links.length, 2);
    saved.links[0].url = 'https://example.test/updated-payroll';
    await saved.save();
    await seedAutomationCatalog();
    const reseeded = await AutomationGroup.findById(hamilton._id);
    assert.equal(reseeded.links.length, 6);
    assert.equal(reseeded.links[0].url, 'https://example.test/updated-payroll');
  } finally {
    await mongoose.disconnect();
    await db.stop();
  }
});

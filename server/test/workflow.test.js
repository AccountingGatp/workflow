import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../src/services/recurrence.js';
import { scheduleFields } from '../src/services/schedule.js';
import { applyTaskTransition } from '../src/services/task-review.js';

test('monthly and twice-monthly calendar rules include month end and leap years', () => {
  assert.equal(matches({ frequency: 'monthly', monthDay: 12 }, new Date(2026,10,12)), true);
  assert.equal(matches({ frequency: 'monthly', monthDay: 31 }, new Date(2026,1,28)), true);
  assert.equal(matches({ frequency: 'monthly', monthDay: 31 }, new Date(2028,1,29)), true);
  assert.equal(matches({ frequency: 'semimonthly', monthDays: [5,20] }, new Date(2026,10,20)), true);
  assert.equal(matches({ frequency: 'semimonthly', monthDays: [5,20] }, new Date(2026,10,19)), false);
  assert.equal(matches({ frequency: 'weekly', weekday: 3 }, new Date(2026,10,18)), true);
  assert.equal(matches({ frequency: 'weekly', weekdays: [1,3], weekday: 0 }, new Date(2026,10,16)), true);
});
test('schedule validation rejects missing, duplicate and invalid dates', () => {
  for (const body of [{ frequency: 'semimonthly', monthDays: [12,12] }, { frequency: 'semimonthly', monthDays: [1,32] }, { frequency: 'monthly', monthDay: 0 }, { frequency: 'weekly', weekday: 7 }, { frequency: 'monthly' }]) assert.throws(() => scheduleFields(body));
  assert.deepEqual(scheduleFields({ frequency: 'semimonthly', monthDays: [20,5] }).monthDays,[5,20]);
  assert.equal(scheduleFields({ frequency: 'monthly', monthDay: 31 }).monthDay,31);
});
test('assignees complete tasks directly after the checklist is finished', () => {
  const task = { status: 'in_progress', checklist: [{ done: false }] };
  const employee = { manager: false, isAssignee: true, actorId: 'employee' };
  assert.throws(() => applyTaskTransition(task, { status: 'done' }, employee), /checklist/);
  task.checklist[0].done = true;
  applyTaskTransition(task, { status: 'done' }, employee);
  assert.equal(task.status, 'done');
  assert.equal(task.completedBy, 'employee');
  assert.ok(task.completedAt);
  applyTaskTransition(task, { status: 'in_progress' }, employee);
  assert.equal(task.completedAt, undefined);
});

test('legacy submissions can be completed without a reviewer', () => {
  const task = { status: 'pending_review', submittedBy: 'employee', checklist: [] };
  assert.throws(() => applyTaskTransition(task, { status: 'done' }, { actorId: 'outside' }), /assignee or client manager/);
  applyTaskTransition(task, { status: 'done' }, { isAssignee: true, actorId: 'employee' });
  assert.equal(task.status, 'done');
  assert.equal(task.submittedBy, undefined);
});

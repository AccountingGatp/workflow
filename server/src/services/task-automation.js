import { isObjectIdOrHexString } from 'mongoose';
import { ProjectWorkItem, Task } from '../models/index.js';

export const automationCodes = ['A', 'YTA', 'N/A'];
export const clientSpecificTaskTitle = /^client[ -]+specific[ -]+tasks?(?:\s*$|\s*[:–—-])/i;
export const automationCode = ({ title, automationStatus }) =>
  automationStatus === true ? 'A' : clientSpecificTaskTitle.test(title || '') ? 'N/A' : 'YTA';

export async function loadEntryAutomation(submissions) {
  const entries = submissions.flatMap((submission) => submission.entries);
  const masterIds = [...new Set(entries.map(({ workItemId }) => workItemId).filter(isObjectIdOrHexString))];
  const taskIds = [...new Set(entries.filter((entry) => !entry.workItemId && !entry.catalogId)
    .map(({ workflowTaskId }) => workflowTaskId).filter(isObjectIdOrHexString))];
  const [items, scheduled] = await Promise.all([
    masterIds.length ? ProjectWorkItem.find({ _id: { $in: masterIds } }).select('title automationStatus').lean() : [],
    taskIds.length ? Task.distinct('_id', { _id: { $in: taskIds }, dailyWorkCustom: { $ne: true } }) : [],
  ]);
  return {
    masterItems: new Map(items.map((item) => [String(item._id), item])),
    scheduledTasks: new Set(scheduled.map(String)),
  };
}

export function entryAutomationCode(entry, context) {
  if (!entry.workItemId && !entry.catalogId && !context?.scheduledTasks.has(entry.workflowTaskId)) return null;
  return automationCode(context?.masterItems.get(String(entry.workItemId)) || entry);
}

import { isObjectIdOrHexString } from 'mongoose';
import { ProjectWorkItem } from '../models/index.js';

export const automationCodes = ['A', 'YTA', 'N/A'];
export const clientSpecificTaskTitle = /^client[ -]+specific[ -]+tasks?(?:\s*$|\s*[:–—-])/i;
export const automationCode = ({ title, automationStatus }) =>
  automationStatus === true ? 'A' : clientSpecificTaskTitle.test(title || '') ? 'N/A' : 'YTA';

export async function automationByWorkItem(submissions) {
  const ids = [...new Set(submissions.flatMap(({ entries }) => entries.map(({ workItemId }) => workItemId))
    .filter(isObjectIdOrHexString))];
  if (!ids.length) return new Map();
  const items = await ProjectWorkItem.find({ _id: { $in: ids } }).select('title automationStatus').lean();
  return new Map(items.map((item) => [String(item._id), item]));
}

export function entryAutomationCode(entry, workItems) {
  return automationCode(workItems.get(String(entry.workItemId)) || entry);
}

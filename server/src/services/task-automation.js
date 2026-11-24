import { isObjectIdOrHexString } from 'mongoose';
import { ProjectWorkItem } from '../models/index.js';

export const automationCode = (status) => status === true ? 'Y' : status === false ? 'N' : 'A';

export async function automationByWorkItem(submissions) {
  const ids = [...new Set(submissions.flatMap(({ entries }) => entries.map(({ workItemId }) => workItemId))
    .filter(isObjectIdOrHexString))];
  if (!ids.length) return new Map();
  const items = await ProjectWorkItem.find({ _id: { $in: ids } }).select('automationStatus').lean();
  return new Map(items.map((item) => [String(item._id), item]));
}

// Entries without a master task, such as manual Daily Work, have no automation classification.
export function entryAutomationCode(entry, workItems) {
  const item = workItems.get(String(entry.workItemId));
  return item ? automationCode(item.automationStatus) : null;
}

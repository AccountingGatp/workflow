import { HttpError } from '../middleware/auth.js';

export function applyTaskTransition(task, body, { manager, isAssignee, actorId }) {
  // Older clients may still send the former submit status.
  const status = body.status === 'pending_review' ? 'done' : body.status;
  if (!['todo', 'in_progress', 'waiting', 'done'].includes(status)) throw new HttpError(400, 'Invalid status');
  if (!manager && !isAssignee) throw new HttpError(403, 'Only an assignee or client manager can change the status');
  if (status === task.status) return;
  if (task.status === 'done' && !manager && String(task.completedBy) !== String(actorId)) {
    throw new HttpError(403, 'Ask a client manager to reopen this task');
  }
  if (status === 'done' && task.checklist.some((item) => !item.done)) {
    throw new HttpError(400, 'Complete all checklist steps before finishing');
  }
  task.status = status;
  task.completedAt = status === 'done' ? new Date() : undefined;
  task.completedBy = status === 'done' ? actorId : undefined;
  task.submittedAt = undefined;
  task.submittedBy = undefined;
  task.reviewedAt = undefined;
  task.reviewedBy = undefined;
}

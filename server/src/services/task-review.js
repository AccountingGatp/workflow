import { HttpError } from '../middleware/auth.js';

export function mayReview(task, { manager, actorId, actorRole = 'admin' }) {
  const reviewer = task.reviewer?._id || task.reviewer;
  return !task.dailyWorkCustom && actorRole === 'admin' && (reviewer ? String(reviewer) === String(actorId) : manager);
}

export function applyTaskTransition(task, body, { manager, isAssignee, actorId, actorRole = 'employee' }) {
  const now = new Date();
  if (body.confirmCompletion) {
    if (!mayReview(task, { manager, actorId, actorRole })) throw new HttpError(403, 'Only the designated team leader can confirm this task');
    if (task.status !== 'pending_review') throw new HttpError(400, 'Employee must submit the task for review first');
    if (String(task.submittedBy) === String(actorId)) throw new HttpError(400, 'Another manager must review your own submission');
    if (task.checklist.some(c => !c.done)) throw new HttpError(400, 'Complete all checklist steps first');
    task.status = 'done'; task.completedAt = now; task.completedBy = task.submittedBy;
    task.reviewedAt = now; task.reviewedBy = actorId;
    return;
  }
  let status = body.status;
  if (!['todo', 'in_progress', 'waiting', 'pending_review', 'done'].includes(status)) throw new HttpError(400, 'Invalid status');
  // Team leads, admins, and employees logging custom Daily Work complete these assignments directly.
  if (['done', 'pending_review'].includes(status) && (actorRole !== 'employee' || task.dailyWorkCustom) && isAssignee) {
    if (task.checklist.some(c => !c.done)) throw new HttpError(400, 'Complete all checklist steps before finishing');
    task.status = 'done'; task.completedAt = now; task.completedBy = actorId;
    task.submittedAt = undefined; task.submittedBy = undefined;
    task.reviewedAt = undefined; task.reviewedBy = undefined;
    return;
  }
  if (status === 'done') status = 'pending_review';
  if (status === task.status) return;
  if (task.status === 'done' && !manager) throw new HttpError(403, 'Ask your TL to reopen approved work');
  if (status === 'pending_review') {
    if (!isAssignee) throw new HttpError(403, 'Only an assigned employee can submit completion');
    if (task.checklist.some(c => !c.done)) throw new HttpError(400, 'Complete all checklist steps before submitting');
    task.submittedAt = now; task.submittedBy = actorId;
  } else {
    if (task.status === 'pending_review' && !manager && String(task.submittedBy) !== String(actorId)) throw new HttpError(403, 'Only the submitter or manager can withdraw review');
    task.submittedAt = undefined; task.submittedBy = undefined;
  }
  task.status = status; task.completedAt = undefined; task.completedBy = undefined;
  task.reviewedAt = undefined; task.reviewedBy = undefined;
}

import { HttpError } from '../middleware/auth.js';

export function mayReview(task, { manager, actorId, isSuper = false }) {
  const reviewer = task.reviewer?._id || task.reviewer;
  return reviewer ? isSuper || String(reviewer) === String(actorId) : manager;
}

export function applyTaskTransition(task, body, { manager, isAssignee, actorId, isSuper = false }) {
  const now = new Date();
  if (body.confirmCompletion) {
    if (!mayReview(task, { manager, actorId, isSuper })) throw new HttpError(403, 'Only the designated reviewer or Super Admin can confirm this task');
    if (task.status !== 'pending_review') throw new HttpError(400, 'Employee must submit the task for review first');
    if (String(task.submittedBy) === String(actorId)) throw new HttpError(400, 'Another manager must review your own submission');
    if (task.checklist.some(c => !c.done)) throw new HttpError(400, 'Complete all checklist steps first');
    task.status = 'done'; task.completedAt = now; task.completedBy = task.submittedBy;
    task.reviewedAt = now; task.reviewedBy = actorId;
    return;
  }
  let status = body.status;
  if (!['todo', 'in_progress', 'waiting', 'pending_review', 'done'].includes(status)) throw new HttpError(400, 'Invalid status');
  // Old list buttons posting done also submit for review; they never bypass approval.
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

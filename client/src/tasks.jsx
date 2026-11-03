import { useEffect, useMemo, useState } from 'react';
import { Check, X, BookOpen, ListChecks, History, Building2, Calendar, Flag, Crown, Repeat, Plus, Trash2 } from 'lucide-react';
import { api, useApi, useAuth, useToast, dueInfo, fmtDate, fmtTime, STATUS, toInputDate } from './lib.jsx';
import { Avatar, Avatars, Badge, Drawer, Empty, Field, Modal, Skeleton, StatusBadge, TeamTag, ErrorBox } from './ui.jsx';

/* ---------- List ---------- */

export function TaskRow({ task, onOpen, onToggle, showPeople }) {
  const due = dueInfo(task);
  const doneCount = task.checklist?.filter((c) => c.done).length || 0;
  return (
    <div className="list-item" role="button" tabIndex={0} onClick={() => onOpen(task)} onKeyDown={(e) => e.key === 'Enter' && onOpen(task)}>
      <button
        className={`check ${task.status === 'done' ? 'done' : ''}`}
        aria-label={task.status === 'done' ? 'Mark as not done' : 'Mark as done'}
        onClick={(e) => { e.stopPropagation(); onToggle?.(task); }}
      ><Check size={14} strokeWidth={3} /></button>
      <div className="li-main">
        <div className="title" style={task.status === 'done' ? { textDecoration: 'line-through', color: 'var(--text-3)' } : undefined}>
          {task.title}{task.template && <Repeat size={12} style={{ marginLeft: 6, verticalAlign: -1, color: 'var(--text-3)' }} aria-label="Recurring" />}
        </div>
        <div className="li-meta">
          <span>{task.client?.name}</span>
          {task.checklist?.length > 0 && <><span>·</span><span className="mono">{doneCount}/{task.checklist.length} steps</span></>}
          {showPeople && <><span>·</span><span>{task.assignees.map((a) => a.name).join(', ') || 'Unassigned'}</span></>}
          {task.status === 'done' && task.completedBy && <><span>·</span><span style={{ color: 'var(--success)' }}>Done by {task.completedBy.name}</span></>}
        </div>
        {showPeople && task.checklist?.length > 0 && task.status !== 'done' && (
          <div className="bar" style={{ height: 4, marginTop: 6, maxWidth: 220 }}><span style={{ width: `${(doneCount / task.checklist.length) * 100}%`, background: 'var(--success)' }} /></div>
        )}
      </div>
      {task.priority === 'high' && <Flag size={16} color="var(--danger)" aria-label="High priority" />}
      {task.status !== 'todo' && task.status !== 'done' && <StatusBadge status={task.status} />}
      <Badge cls={due.cls}>{due.label}</Badge>
      <Avatars people={task.assignees} />
    </div>
  );
}

export function useTaskToggle(reload) {
  const toast = useToast();
  return async (task) => {
    const status = task.status === 'done' ? 'todo' : 'done';
    try { await api(`/tasks/${task._id}`, { method: 'PATCH', body: { status } }); toast(status === 'done' ? `“${task.title}” completed` : 'Task reopened'); reload(); }
    catch (e) { toast(e.message); }
  };
}

/* ---------- Detail drawer ---------- */

export function TaskDrawer({ id, onClose, onChanged }) {
  const { data: task, loading, error, reload } = useApi(`/tasks/${id}`, [id]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => { reload(); onChanged?.(); };

  const patch = async (body) => {
    setBusy(true);
    try { await api(`/tasks/${id}`, { method: 'PATCH', body }); refresh(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };

  return (
    <Drawer onClose={onClose} label="Task details">
      <div className="row" style={{ padding: '16px 16px 0 24px' }}>
        <span className="small muted">Task</span><div className="spacer" />
        <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
      </div>
      <div className="drawer-body">
        {loading && !task && <Skeleton rows={6} />}
        <ErrorBox error={error} />
        {task && (() => {
          const due = dueInfo(task);
          const done = task.checklist.filter((c) => c.done).length;
          return (
            <>
              <h2 style={{ fontSize: 24, lineHeight: '32px', marginBottom: 12 }}>{task.title}</h2>
              <div className="row-wrap" style={{ marginBottom: 20 }}>
                <StatusBadge status={task.status} /><Badge cls={due.cls}>{due.label}</Badge>
                {task.priority === 'high' && <Badge cls="b-danger"><Flag size={12} />High priority</Badge>}
                {task.template && <Badge cls="b-violet"><Repeat size={12} />Recurring</Badge>}
              </div>

              <div className="card" style={{ padding: 16, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px 16px', alignItems: 'center' }}>
                <span className="muted row"><Building2 size={16} />Client</span><strong>{task.client.name}</strong>
                <span className="muted row"><Calendar size={16} />Due</span><span>{fmtDate(task.dueDate)}</span>
                <span className="muted row">Assigned</span>
                <div className="row-wrap">
                  {task.assignees.map((a) => (
                    <span key={a._id} className="badge" style={{ paddingLeft: 3 }}>
                      <Avatar name={a.name} size="sm" />{a.name}
                      {String(task.owner?._id) === String(a._id) && <Crown size={12} color="var(--warning)" aria-label="Owner" />}
                    </span>
                  ))}
                </div>
              </div>

              <div className="section-title">Status</div>
              <div className="chips" role="radiogroup" aria-label="Status">
                {Object.entries(STATUS).map(([k, v]) => (
                  <button key={k} className={`chip ${task.status === k ? 'on' : ''}`} role="radio" aria-checked={task.status === k} disabled={busy} onClick={() => patch({ status: k })}>{v.label}</button>
                ))}
              </div>

              {task.sop && <>
                <div className="section-title"><BookOpen size={14} />Standard operating procedure</div>
                <div className="sop">{task.sop}</div>
              </>}

              {task.checklist.length > 0 && <>
                <div className="section-title"><ListChecks size={14} />Checklist <span className="mono" style={{ marginLeft: 'auto' }}>{done}/{task.checklist.length}</span></div>
                <div className="bar" style={{ marginBottom: 8 }}><span style={{ width: `${(done / task.checklist.length) * 100}%`, background: 'var(--success)' }} /></div>
                <div className="card">
                  {task.checklist.map((c) => (
                    <label key={c._id} className="list-item" style={{ cursor: 'pointer' }}>
                      <button className={`check ${c.done ? 'done' : ''}`} disabled={busy} aria-label={c.text}
                        onClick={(e) => { e.preventDefault(); patch({ checklistItem: { id: c._id, done: !c.done } }); }}><Check size={14} strokeWidth={3} /></button>
                      <div className="li-main">
                        <div className="title" style={c.done ? { textDecoration: 'line-through', color: 'var(--text-3)' } : undefined}>{c.text}</div>
                        {c.done && c.doneBy && <div className="li-meta">{c.doneBy.name} · {fmtTime(c.doneAt)}</div>}
                      </div>
                    </label>
                  ))}
                </div>
              </>}

              <div className="section-title"><History size={14} />Activity</div>
              {task.activity.length === 0 ? <p className="small muted">No activity yet.</p> : (
                <div className="timeline">
                  {task.activity.map((a) => (
                    <div key={a._id} className="timeline-item">
                      <Avatar name={a.actor?.name || 'System'} size="sm" />
                      <div><strong>{a.actor?.name || 'System'}</strong> {a.summary}<div className="small muted">{fmtTime(a.createdAt)}</div></div>
                    </div>
                  ))}
                </div>
              )}
              {task.status !== 'done' && (
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 24 }} disabled={busy} onClick={() => patch({ status: 'done' })}>
                  <Check size={18} />Mark task completed
                </button>
              )}
            </>
          );
        })()}
      </div>
    </Drawer>
  );
}

/* ---------- Create task / recurring template ---------- */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function TaskForm({ recurring = false, presetClient, template = null, onClose, onSaved }) {
  const clients = useApi('/clients');
  const users = useApi('/users');
  const toast = useToast();
  const [f, setF] = useState({
    title: template?.title || '', client: presetClient || template?.client?._id || '', assignees: template?.assignees?.map(a => a._id || a) || [], owner: template?.owner?._id || template?.owner || '', dueDate: toInputDate(new Date()),
    priority: template?.priority || 'normal', sop: template?.sop || '', checklist: template?.checklist?.length ? [...template.checklist] : [''], frequency: template?.frequency || 'weekly', weekday: template?.weekday ?? 1, monthDay: template?.monthDay ?? 1,
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));

  const manageable = (clients.data || []).filter((c) => c.canManage);
  const people = useMemo(() => (users.data || []).filter((u) => u.active && u.role !== 'super_admin'), [users.data]);

  const toggleAssignee = (id) => setF((s) => {
    const assignees = s.assignees.includes(id) ? s.assignees.filter((x) => x !== id) : [...s.assignees, id];
    return { ...s, assignees, owner: assignees.includes(s.owner) ? s.owner : assignees[0] || '' };
  });

  const submit = async (e) => {
    e.preventDefault(); setError(null); setSaving(true);
    const body = {
      title: f.title, client: f.client, assignees: f.assignees, owner: f.owner || undefined,
      priority: f.priority, sop: f.sop, checklist: f.checklist.map((s) => s.trim()).filter(Boolean),
      ...(recurring
        ? { frequency: f.frequency, weekday: Number(f.weekday), monthDay: Number(f.monthDay) }
        : { dueDate: new Date(`${f.dueDate}T17:00:00`).toISOString() }),
    };
    try {
      const res = await api(template ? `/templates/${template._id}/details` : recurring ? '/templates' : '/tasks', { method: template ? 'PATCH' : 'POST', body });
      toast(template ? 'Recurring task updated' : recurring ? `Scheduled — ${res.created} upcoming task${res.created === 1 ? '' : 's'} created` : 'Task created');
      onSaved?.(); onClose();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  return (
    <Modal wide title={template ? 'Edit recurring task' : recurring ? 'Schedule recurring work' : 'New task'} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" form="task-form" disabled={saving || !f.title || !f.client}>{saving ? 'Saving…' : template ? 'Save changes' : recurring ? 'Schedule' : 'Create task'}</button>
    </>}>
      <form id="task-form" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        {template && <div className="form-note">Saving changes replaces unstarted future occurrences with the updated schedule. Completed, in-progress, and past tasks are preserved.</div>}
        <Field label="Task name"><input className="input" value={f.title} onChange={set('title')} placeholder="e.g. Weekly Bill Updation" required autoFocus /></Field>
        <Field label="Client"><select className="select" value={f.client} onChange={set('client')} required disabled={!!template}><option value="">Select client…</option>{manageable.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        {recurring ? (
          <div className="grid grid-2">
            <Field label="Repeats">
              <select className="select" value={f.frequency} onChange={set('frequency')}>
                <option value="daily">Every working day</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
            </Field>
            {f.frequency === 'weekly' && <Field label="On"><select className="select" value={f.weekday} onChange={set('weekday')}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>}
            {f.frequency === 'monthly' && <Field label="Day of month"><select className="select" value={f.monthDay} onChange={set('monthDay')}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></Field>}
          </div>
        ) : (
          <div className="grid grid-2">
            <Field label="Due date"><input type="date" className="input" value={f.dueDate} onChange={set('dueDate')} required /></Field>
            <Field label="Priority"><select className="select" value={f.priority} onChange={set('priority')}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></Field>
          </div>
        )}
        <Field label="Assign to" hint={f.assignees.length > 1 ? 'Click the crown to choose who owns the task.' : 'They get access to this client automatically.'}>
          <div className="chips">
            {people.map((p) => {
              const on = f.assignees.includes(p._id);
              return (
                <span key={p._id} className={`chip ${on ? 'on' : ''}`} style={{ paddingLeft: 4 }} onClick={() => toggleAssignee(p._id)} role="checkbox" aria-checked={on} tabIndex={0}
                  onKeyDown={(e) => e.key === ' ' && (e.preventDefault(), toggleAssignee(p._id))}>
                  <Avatar name={p.name} size="sm" />{p.name}
                  {on && f.assignees.length > 1 && (
                    <Crown size={14} color={f.owner === p._id ? 'var(--warning)' : 'var(--text-3)'} aria-label="Make owner"
                      onClick={(e) => { e.stopPropagation(); setF((s) => ({ ...s, owner: p._id })); }} />
                  )}
                </span>
              );
            })}
          </div>
        </Field>
        <Field label="SOP / instructions"><textarea className="textarea" value={f.sop} onChange={set('sop')} placeholder={'1. Open the inbox\n2. Enter bills in Xero\n3. …'} /></Field>
        <Field label="Checklist">
          <div className="stack" style={{ gap: 8 }}>
            {f.checklist.map((item, i) => (
              <div key={i} className="row">
                <input className="input" value={item} placeholder={`Step ${i + 1}`}
                  onChange={(e) => setF((s) => ({ ...s, checklist: s.checklist.map((x, j) => (j === i ? e.target.value : x)) }))} />
                {f.checklist.length > 1 && <button type="button" className="btn btn-ghost icon-btn" aria-label="Remove step"
                  onClick={() => setF((s) => ({ ...s, checklist: s.checklist.filter((_, j) => j !== i) }))}><Trash2 size={16} /></button>}
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF((s) => ({ ...s, checklist: [...s.checklist, ''] }))}><Plus size={16} />Add step</button>
          </div>
        </Field>
      </form>
    </Modal>
  );
}

export function TaskPagination({ page, totalPages, total, pageSize, setPage }) {
  if (totalPages <= 1) return null;
  return <div className="row-wrap" style={{ justifyContent: 'space-between', marginTop: 14, marginBottom: 12, gap: 12 }}>
    <span className="small muted">Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} tasks</span>
    <div className="row" style={{ gap: 8 }}>
      <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</button>
      <span className="small mono">Page {page} / {totalPages}</span>
      <button className="btn btn-outline btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</button>
    </div>
  </div>;
}

export function TaskListCard({ tasks, loading, onOpen, onToggle, groups = true, showPeople, emptyTitle = 'Nothing here' }) {
  if (loading && !tasks) return <div className="card"><Skeleton /></div>;
  if (!tasks?.length) return <div className="card"><Empty icon={ListChecks} title={emptyTitle} /></div>;
  if (!groups) return <div className="card list">{tasks.map((t) => <TaskRow key={t._id} task={t} onOpen={onOpen} onToggle={onToggle} showPeople={showPeople} />)}</div>;
  const order = [['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Recently completed']];
  const by = Object.groupBy ? Object.groupBy(tasks, (t) => dueInfo(t).bucket) : tasks.reduce((a, t) => ((a[dueInfo(t).bucket] ||= []).push(t), a), {});
  return (
    <div className="card list" style={{ overflow: 'hidden' }}>
      {order.filter(([k]) => by[k]?.length).map(([k, label]) => (
        <div key={k}>
          <div className="group-label"><span>{label}</span><span className="mono">{by[k].length}</span></div>
          {by[k].map((t) => <TaskRow key={t._id} task={t} onOpen={onOpen} onToggle={onToggle} showPeople={showPeople} />)}
        </div>
      ))}
    </div>
  );
}

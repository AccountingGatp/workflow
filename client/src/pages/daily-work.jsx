import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ClipboardList, Plus, Search, Send, StickyNote, Trash2 } from 'lucide-react';
import { api, useApi, useAuth, useToast } from '../lib.jsx';
import { Badge, Empty, ErrorBox, PageHead, Skeleton } from '../ui.jsx';
import { ManageDailyWork } from './daily-work-manage.jsx';

const root = '/daily-work';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata' }).format(new Date());
const hours = (number) => Number(number || 0).toFixed(2);
const nameKey = (value) => value.trim().toLowerCase();
const dueLabel = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const totalHours = (rows) => hours(rows.reduce((sum, item) => sum + Number(item.hours || 0), 0));
const deliveryLabel = {
  sent: 'Saved and sent to Slack.',
  pending: 'Saved. Slack delivery is queued.',
  sending: 'Saved. Slack delivery is in progress.',
  failed: 'Saved. Slack delivery will retry.',
  uncertain: 'Saved. Slack delivery could not be confirmed.',
  skipped: 'Tasks saved.',
};

function DateField({ value, onChange, label = 'Work date' }) {
  return <label className="field"><span>{label}</span><input className="input" type="date" max={today()} value={value}
    onChange={(event) => event.target.value && onChange(event.target.value)} /></label>;
}

function ProjectPicker({ projects, selected, onSelect }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const input = useRef(null);
  const label = (project) => project.clientName && project.clientName !== project.name ? `${project.clientName} / ${project.name}` : project.name;
  const matches = projects.filter((project) => nameKey(label(project)).includes(nameKey(search)));
  const active = matches[highlight];

  function close() {
    setOpen(false);
    setSearch('');
    setHighlight(0);
  }

  function select(project) {
    onSelect(project._id);
    close();
  }

  return <div className="field daily-picker-fields" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <label htmlFor="daily-project">Project</label>
    <div className="daily-project-combo">
      <div className="daily-search"><Search size={17} aria-hidden="true" />
        <input ref={input} id="daily-project" className="input" role="combobox" aria-autocomplete="list"
          aria-expanded={open} aria-controls={open ? 'daily-project-options' : undefined}
          aria-activedescendant={open && active ? `daily-project-option-${active._id}` : undefined}
          autoComplete="off" value={open ? search : selected ? label(selected) : ''}
          placeholder="Search or select a project"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => { setSearch(event.target.value); setHighlight(0); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              const next = open ? Math.max(0, Math.min(matches.length - 1, highlight + (event.key === 'ArrowDown' ? 1 : -1))) : 0;
              setHighlight(next);
              if (matches[next]) document.getElementById(`daily-project-option-${matches[next]._id}`)?.scrollIntoView({ block: 'nearest' });
            }
            if (event.key === 'Enter' && open && active) {
              event.preventDefault();
              select(active);
            }
          }} />
        <button type="button" className="btn btn-ghost icon-btn daily-combo-toggle" tabIndex={-1}
          aria-label={open ? 'Close projects' : 'Show projects'} onMouseDown={(event) => event.preventDefault()}
          onClick={() => { if (open) close(); else { input.current.focus(); setOpen(true); } }}><ChevronDown size={16} /></button>
      </div>
      {open && <ul id="daily-project-options" className="daily-project-options" role="listbox" aria-label="Projects">
        {matches.map((project, index) => <li key={project._id} role="option" id={`daily-project-option-${project._id}`}
          aria-selected={highlight === index} onMouseEnter={() => setHighlight(index)}
          onMouseDown={(event) => event.preventDefault()} onClick={() => select(project)}>{label(project)}</li>)}
        {!matches.length && <li role="presentation" className="small muted">{projects.length ? 'No projects match your search.' : 'No projects available.'}</li>}
      </ul>}
    </div>
  </div>;
}

const savedRow = (entry, key = entry._id) => ({ ...entry, key, collapsed: true });
const entryPayload = ({ _id, projectId, title, description, note, hours, status, priority, catalogId, workItemId, workflowTaskId, checklistChanges }) => ({
  _id, projectId, title, description, note, hours, status, priority, catalogId, workItemId, workflowTaskId, checklistChanges,
});

function EntryEditor({ date, data }) {
  const [submission, setSubmission] = useState(data.submission);
  const [rows, setRows] = useState(() => (data.submission?.entries || []).map((entry) => savedRow(entry)));
  const [catalog, setCatalog] = useState(data.catalog);
  const [project, setProject] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const editor = useRef(null);
  const newEntry = useRef(null);
  const toast = useToast();
  useEffect(() => {
    if (!newEntry.current) return;
    const row = editor.current?.querySelector(`[data-entry-key="${newEntry.current}"]`);
    const field = row?.querySelector('[data-focus-summary]:not([disabled]), [data-entry-focus]');
    newEntry.current = null;
    field?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [rows]);
  const selected = data.projects.find((item) => item._id === project);
  const update = (key, patch) => setRows((old) => old.map((row) => row.key === key ? { ...row, ...patch } : row));

  function taskFor(row) {
    const tasks = catalog.filter((task) => task.projectId === row.projectId);
    return tasks.find((task) => task._id === row.catalogId || (task.workItemId && task.workItemId === row.workItemId)) ||
      tasks.find((task) => nameKey(task.title) === nameKey(row.title));
  }

  function available(task, excludedKey) {
    const used = rows.reduce((sum, row) => {
      if (row.key === excludedKey) return sum;
      const matches = task.review ? nameKey(row.title) === 'review' : taskFor(row)?._id === task._id;
      return matches ? sum + Math.round(Number(row.hours || 0) * 100) : sum;
    }, 0);
    return Math.max(0, Math.round(task.remainingHours * 100) - used) / 100;
  }

  const masterItems = data.workItems.filter((item) => item.projectId === project);
  const projectTasks = [
    ...masterItems,
    ...catalog.filter((task) => task.projectId === project && !task.workItemId &&
      !masterItems.some((item) => nameKey(item.title) === nameKey(task.title)))
      .map((task) => ({ ...task, id: task._id, catalogId: task._id, canLog: true })),
  ].sort((a, b) => a.title.localeCompare(b.title));
  const visibleTasks = projectTasks.filter((item) => [item.title, item.description || '']
    .some((text) => nameKey(text).includes(nameKey(taskSearch))));

  function chooseProject(id) {
    setProject(id);
    setTaskSearch('');
    refreshAvailability();
  }

  function add(item) {
    const source = data.projects.find((entry) => entry._id === item.projectId);
    if (!source || busy || rows.length >= 40) return;
    const occurrence = item.occurrence;
    const key = crypto.randomUUID();
    newEntry.current = key;
    setRows((old) => [...old, {
      key, projectId: source._id, projectName: source.name, title: item.title, description: item.description || '',
      catalogId: item.catalogId, workItemId: item.catalogId ? undefined : item.id,
      checklist: occurrence?.checklist, workflowStatus: occurrence?.status,
      workflowTaskId: item.occurrenceDueToday ? occurrence?.id : undefined,
      hours: '',
      priority: occurrence?.priority || 'normal', status: occurrence?.status === 'done' ? 'complete' : 'incomplete',
    }]);
  }

  const refreshAvailability = useCallback(async () => {
    try {
      const day = await api(`${root}/day/${date}`);
      setCatalog(day.catalog);
    } catch { /* Keep the current balance visible if the connection drops. */ }
  }, [date]);
  useEffect(() => {
    window.addEventListener('focus', refreshAvailability);
    return () => window.removeEventListener('focus', refreshAvailability);
  }, [refreshAvailability]);

  async function saveRow(row, remove = false) {
    if (remove && !row._id) {
      setRows((old) => old.filter((item) => item.key !== row.key));
      return;
    }
    setBusy(row.key);
    setError(null);
    try {
      const saved = submission?.entries || [];
      const entries = row._id
        ? saved.flatMap((entry) => entry._id !== row._id ? [entry] : remove ? [] : [entryPayload(row)])
        : [...saved, entryPayload(row)];
      const response = await api(`${root}/day/${date}`, { method: 'PUT', body: { entries, version: submission?.version } });
      setSubmission(response);
      if (remove) {
        setRows((old) => old.filter((item) => item.key !== row.key));
      } else {
        const entry = row._id ? response.entries.find((item) => item._id === row._id) :
          response.entries.find((item) => !saved.some((previous) => previous._id === item._id));
        if (entry) {
          newEntry.current = row.key;
          setRows((old) => old.map((item) => item.key === row.key ? savedRow(entry, item.key) : item));
        }
      }
      await refreshAvailability();
    } catch (error) {
      setError(error);
      if (error.status === 400) await refreshAvailability();
    } finally { setBusy(''); }
  }

  async function sendToSlack() {
    setBusy('slack');
    setError(null);
    try {
      const response = await api(`${root}/day/${date}/slack`, { method: 'POST', body: { version: submission.version } });
      setSubmission(response);
      toast(deliveryLabel[response.delivery] || 'Slack delivery is queued.');
    } catch (error) { setError(error); }
    finally { setBusy(''); }
  }

  const suggestions = [
    ...data.workItems.filter((item) => item.canLog && item.suggested),
    ...catalog.filter((task) => task.review && data.reviewProjects?.includes(task.projectId))
      .map((task) => ({ ...task, id: task._id, catalogId: task._id })),
  ].filter((item) => {
    const picked = rows.some((row) => row.projectId === item.projectId &&
      (row.catalogId === item.id || row.workItemId === item.id || (!row.catalogId && !row.workItemId && nameKey(row.title) === nameKey(item.title))));
    const limit = taskFor({ ...item, workItemId: item.id });
    return !picked && (!limit || available(limit) > 0);
  });

  return <div className="daily-entry-layout">
    <section className="card daily-card daily-project-picker" aria-labelledby="daily-project-heading">
      <div className="row-wrap daily-header"><h2 id="daily-project-heading">Daily entry</h2><Badge cls="b-primary">{data.memberName}</Badge></div>
      <ProjectPicker projects={data.projects} selected={selected} onSelect={chooseProject} />
      {selected && suggestions.length > 0 && <button type="button" className="btn btn-ghost btn-sm daily-open-suggestions"
        onClick={() => chooseProject('')}>View suggestions</button>}
      {!selected && suggestions.length > 0 && <section className="daily-suggestions" aria-labelledby="daily-suggestion-heading">
        <h3 id="daily-suggestion-heading">Suggested for {date === today() ? 'today' : dueLabel.format(new Date(`${date}T00:00:00+05:30`))}</h3>
        <ul className="daily-project-tasks" aria-label="Suggested tasks">
          {suggestions.map((item) => {
            const source = data.projects.find((project) => project._id === item.projectId);
            const limit = taskFor({ ...item, workItemId: item.id });
            return <li key={item.id} className="daily-project-task">
              <div className="daily-project-task-info">
                <strong>{item.title}</strong>
                <div className="small muted">{source?.name}{item.review ? ' · Team review' : ' · Scheduled'}</div>
                {item.description && !item.review && <p className="small muted daily-task-description">{item.description}</p>}
                {limit && <span className="small muted">{hours(available(limit))} h available</span>}
              </div>
              <button type="button" className="btn btn-tonal btn-sm" aria-label={`Add suggested ${item.title} from ${source?.name}`}
                disabled={!!busy || rows.length >= 40} onClick={() => add(item)}><Plus size={15} /> Add</button>
            </li>;
          })}
        </ul>
      </section>}
      {!data.projects.length && <p className="small muted">Client projects you have access to appear here automatically.</p>}
    </section>
    {selected && <section className="card daily-card daily-project-task-panel" aria-labelledby="daily-project-tasks">
      <h2 id="daily-project-tasks">{selected.name} tasks</h2>
      <label className="field daily-task-search"><span>Find a task</span>
        <span className="daily-search"><Search size={17} aria-hidden="true" />
          <input className="input" type="search" placeholder="Search tasks and descriptions" value={taskSearch}
            onChange={(event) => setTaskSearch(event.target.value)} /></span>
      </label>
      {!visibleTasks.length ? <p className="small muted">{taskSearch.trim() ? 'No tasks match your search.' : 'No tasks are listed for this project.'}</p> :
        <ul className="daily-project-tasks" aria-label="Project tasks">
          {visibleTasks.map((item) => {
            const limit = taskFor({ ...item, workItemId: item.id });
            const remaining = limit && available(limit);
            const period = limit?.period || item.period;
            return <li key={item.id} className="daily-project-task">
              <div className="daily-project-task-info">
                <strong>{item.title}</strong>
                {item.description && <p className="small muted daily-task-description">{item.description}</p>}
                {period && <div className="row-wrap small muted">
                  <span className="daily-status">{period}</span>
                  <span>{limit ? `${hours(remaining)} h left of ${hours(limit.hours)} h` : 'Hour limit not set'}</span>
                </div>}
                {!item.canLog && <span className="small muted">Assigned to {item.responsible || 'another employee'}</span>}
              </div>
              <button type="button" className="btn btn-tonal btn-sm" aria-label={`Add ${item.title}`}
                disabled={!item.canLog || busy || rows.length >= 40 || remaining === 0} onClick={() => add(item)}>
                <Plus size={15} /> Add
              </button>
            </li>;
          })}
        </ul>}
    </section>}
    <section ref={editor} className="card daily-task-editor" aria-labelledby="daily-selected-heading">
      <div className="row-wrap daily-header daily-editor-bar">
        <div><h2 id="daily-selected-heading">Selected tasks</h2><time className="small muted" dateTime={date}>{dueLabel.format(new Date(`${date}T00:00:00+05:30`))}</time></div>
        <div className="row-wrap daily-editor-totals" aria-live="polite">
          <Badge cls="b-primary"><span className="mono">{totalHours(submission?.entries || [])} h</span> {date === today() ? 'today' : 'total'}</Badge>
          <div className="stack" style={{ gap: 2 }}>
            <button type="button" className="btn btn-primary" onClick={sendToSlack}
              aria-describedby={data.slackEnabled ? undefined : 'daily-slack-setup'}
              disabled={!data.slackEnabled || !!busy || rows.some((row) => !row.collapsed) ||
                (!submission?.entries.length && !submission?.slackPosted) ||
                ['sent', 'sending', 'pending', 'uncertain'].includes(submission?.delivery)}>
              <Send size={16} />{busy === 'slack' ? 'Sending…' : 'Send to Slack'}
            </button>
            {!data.slackEnabled && <span id="daily-slack-setup" className="small muted">Slack setup required</span>}
          </div>
        </div>
      </div>
      <div className="daily-editor-body stack">
        <ErrorBox error={error} />
        {submission?.delivery && submission.delivery !== 'skipped' && <p className="small muted" role="status">{deliveryLabel[submission.delivery]}</p>}
        {!rows.length && <Empty icon={ClipboardList} title="No tasks selected">Choose a task from the project list to start logging hours.</Empty>}
        {rows.map((row) => {
          const linked = !!(row.workflowTaskId || row.workItemId || row.catalogId);
          const task = taskFor(row);
          const remaining = task && available(task, row.key);
          const original = submission?.entries.find((entry) => entry._id === row._id);
          const existingHours = original && task && taskFor(original)?._id === task._id ? original.hours : 0;
          const maxHours = task ? Math.min(24, remaining) : 24;
          const keepSavedHours = Number(row.hours) === existingHours && existingHours > maxHours;
          const hintId = `hours-limit-${row.key}`;
          return <article className="daily-entry" key={row.key} data-entry-key={row.key}>
            {row.collapsed && <button className="daily-entry-summary" type="button" data-focus-summary
              aria-label={`Open ${row.title} details`} aria-expanded="false" onClick={() => {
                newEntry.current = row.key;
                update(row.key, { collapsed: false, noteOpen: !!row.note });
              }}>
              <span><strong>{row.title}</strong><small className="muted">{row.projectName}</small></span>
              <span className="mono">{hours(row.hours)} h</span>
              <Badge cls={row.priority === 'high' ? 'b-danger' : 'b-primary'}>{row.priority}</Badge>
              <ChevronDown size={16} aria-hidden="true" />
            </button>}
            <div className="daily-reveal" data-open={!row.collapsed}>
              <div inert={!!row.collapsed}>
                <form onSubmit={(event) => { event.preventDefault(); saveRow(row); }}>
                  <fieldset className="daily-entry-fields" disabled={!!busy}>
                    <span className="small muted daily-row-project">{row.projectName}</span>
                    <div className="daily-task-heading">
                      <div className="stack daily-task-name">
                        {linked ? <>
                          <strong className="daily-task-linked">{row.title}</strong>
                          {row.description && <p className="small muted daily-task-description">{row.description}</p>}
                        </> : <>
                          <label className="field"><span>Task</span>
                            <input className="input" maxLength={230} required value={row.title}
                              data-entry-focus={!row.title || undefined}
                              onChange={(event) => update(row.key, { title: event.target.value })} /></label>
                          <label className="field"><span>Description</span>
                            <textarea className="input" rows={2} maxLength={3000} value={row.description || ''}
                              onChange={(event) => update(row.key, { description: event.target.value })} /></label>
                        </>}
                      </div>
                      <button type="button" className="btn btn-ghost icon-btn daily-task-remove" aria-label={`Remove ${row.title || 'task'}`} title="Remove task"
                        onClick={() => saveRow(row, true)}><Trash2 size={17} /></button>
                    </div>
                    <div className="daily-entry-grid">
                      <div className="field">
                        <label htmlFor={`hours-${row.key}`}>Hours</label>
                        <input id={`hours-${row.key}`} className="input" type="number" min="0" max={keepSavedHours ? existingHours : maxHours} step="0.01" required value={row.hours}
                          aria-describedby={task || row.hoursAdjusted ? hintId : undefined}
                          data-entry-focus={!!row.title || undefined}
                          onChange={(event) => {
                            const { value, valueAsNumber } = event.target;
                            const hoursAdjusted = valueAsNumber > maxHours;
                            update(row.key, { hours: hoursAdjusted ? String(maxHours) : value, hoursAdjusted });
                          }} />
                        {(task || row.hoursAdjusted) && <span id={hintId} className="hint" aria-live="polite">
                          {row.hoursAdjusted ? `Adjusted to ${hours(maxHours)} h.` :
                            `Up to ${hours(maxHours)} h · ${task.period}${task.review ? ' · across projects' : ''}`}
                        </span>}
                      </div>
                      <div className="field"><label htmlFor={`priority-${row.key}`}>Priority</label>
                        <select id={`priority-${row.key}`} className="select" value={row.priority} onChange={(event) => update(row.key, { priority: event.target.value })}>
                        <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
                      </select></div>
                      <div className="field"><label htmlFor={`status-${row.key}`}>Status</label>
                        <select id={`status-${row.key}`} className="select" value={row.status} disabled={['done', 'pending_review', 'unavailable'].includes(row.workflowStatus)} onChange={(event) => update(row.key, { status: event.target.value })}>
                        <option value="incomplete">{row.workflowStatus === 'pending_review' ? 'Awaiting TL review' : 'Incomplete'}</option><option value="complete">Complete</option>
                      </select></div>
                    </div>
                    {!!row.checklist?.length && <div className="stack daily-entry-checklist">
                      {row.checklist.map((step) => <label key={step._id} className="row">
                        <input type="checkbox" checked={row.checklistChanges?.find((change) => change.id === step._id)?.done ?? step.done}
                          disabled={['done', 'pending_review', 'unavailable'].includes(row.workflowStatus)}
                          onChange={(event) => update(row.key, { checklistChanges: [
                            ...(row.checklistChanges || []).filter((change) => change.id !== step._id),
                            ...(event.target.checked === step.done ? [] : [{ id: step._id, done: event.target.checked }]),
                          ] })} />{step.text}
                      </label>)}
                    </div>}
                    <div className="daily-note">
                      {!row.noteOpen && <button type="button" className="btn btn-ghost btn-sm" aria-expanded="false" onClick={() => {
                        update(row.key, { noteOpen: true });
                        requestAnimationFrame(() => document.getElementById(`note-${row.key}`)?.focus());
                      }}><StickyNote size={15} /> Add note</button>}
                      <div className="daily-reveal" data-open={!!row.noteOpen}>
                        <div inert={!row.noteOpen}><label className="field">
                          <span>Note <span className="muted">(optional)</span></span>
                          <textarea className="input" id={`note-${row.key}`} rows={2} maxLength={500} value={row.note || ''}
                            onChange={(event) => update(row.key, { note: event.target.value })} />
                        </label></div>
                      </div>
                    </div>
                    <div className="row-wrap daily-row-actions">
                      {original && <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                        newEntry.current = row.key;
                        setRows((old) => old.map((item) => item.key === row.key ? savedRow(original, row.key) : item));
                      }}>Cancel</button>}
                      <button type="submit" className="btn btn-primary btn-sm" aria-label={`Save ${row.title || 'task'}`}>
                        {busy === row.key ? 'Saving…' : 'Save task'}
                      </button>
                    </div>
                  </fieldset>
                </form>
              </div>
            </div>
          </article>;
        })}
      </div>
    </section>
  </div>;
}

function StatusBadge({ entry }) {
  const label = entry.status === 'complete' ? 'Completed' : entry.workflowStatus === 'pending_review' ? 'Awaiting TL review' : 'Incomplete';
  return <Badge cls={entry.status === 'complete' ? 'b-success' : 'b-warning'}>{label}</Badge>;
}

function TaskStatusRow({ entry, me, onSaved }) {
  const { submission } = entry;
  const own = submission.memberId === me;
  const mayUpdate = entry.canReview || (own && !['done', 'unavailable'].includes(entry.workflowStatus));
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState(entry.incompleteReason || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  async function save(status) {
    setBusy(true);
    setError(null);
    try {
      const result = await api(`${root}/day/${submission.date}/members/${submission.memberId}/entries/${entry._id}/status`, {
        method: 'PATCH', body: { status, reason, version: submission.version },
      });
      setShowReason(false);
      toast(result.entry.workflowStatus === 'pending_review' ? 'Submitted for TL review.' : 'Task status saved.');
      onSaved();
    } catch (error) {
      setError(error);
    } finally { setBusy(false); }
  }

  return <article className="card daily-status-item">
    <div className="stack daily-status-info">
      <div className="row-wrap"><h3>{entry.title}</h3><StatusBadge entry={entry} /></div>
      <div className="small muted">{entry.projectName} · {submission.memberName} · <time dateTime={submission.date}>{dueLabel.format(new Date(`${submission.date}T00:00:00+05:30`))}</time> · {hours(entry.hours)} h</div>
      {entry.note && <p className="small daily-task-description">{entry.note}</p>}
      {entry.incompleteReason && !showReason && <p className="small daily-task-description"><strong>Reason</strong> {entry.incompleteReason}</p>}
    </div>
    {mayUpdate && <div className="daily-status-actions">
      {!showReason ? <div className="row-wrap">
        {entry.status !== 'complete' && (!own || entry.workflowStatus !== 'pending_review') &&
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save('complete')}>Mark completed</button>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => {
          setReason(entry.incompleteReason || '');
          setShowReason(true);
        }}>Incomplete</button>
      </div> : <form className="stack" onSubmit={(event) => { event.preventDefault(); if (reason.trim()) save('incomplete'); }}>
        <label className="field"><span>Why is this incomplete?</span>
          <textarea className="input" autoFocus required rows={2} maxLength={500} disabled={busy}
            value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="row-wrap">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !reason.trim()}>Save status</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setShowReason(false); setError(null); }}>Cancel</button>
        </div>
      </form>}
      <ErrorBox error={error} />
    </div>}
  </article>;
}

const reportViews = ['member', 'status', 'summary'];
function DailyReports({ tab, date, setDate, openEntry, me }) {
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [memberId, setMember] = useState('');
  const [projectId, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [slackError, setSlackError] = useState(null);
  const toast = useToast();
  const query = new URLSearchParams({ from, to, memberId, projectId, status: tab === 'status' ? status : '' });
  const { data, error, loading, reload } = useApi(`${root}/reports?${query}`);
  const entries = (data?.submissions || []).flatMap((submission) => submission.entries.map((entry) => ({ ...entry, submission })));
  const projects = new Map();
  for (const entry of entries) {
    const group = projects.get(entry.projectId) || { name: entry.projectName, hours: 0, count: 0 };
    group.hours += entry.hours;
    group.count += 1;
    projects.set(entry.projectId, group);
  }
  async function send() {
    setSlackError(null);
    setSending(true);
    try {
      await api(`${root}/reports/slack?${query}`, { method: 'POST' });
      toast('Project summary sent to Slack.');
    } catch (error) { setSlackError(error); }
    finally { setSending(false); }
  }
  return <div className="stack">
    <div className="card daily-card">
      <div className="row-wrap daily-controls">
        <DateField label="From date" value={from} onChange={(date) => { setFrom(date); if (date > to) setTo(date); }} />
        <DateField label="To date" value={to} onChange={setTo} />
        <label className="field"><span>Member</span><select className="select" value={memberId} onChange={(event) => setMember(event.target.value)}>
          <option value="">All available members</option>{data?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
        <label className="field"><span>Project</span><select className="select" value={projectId} onChange={(event) => setProject(event.target.value)}>
          <option value="">All projects</option>{data?.projects.map((project) => <option key={project._id} value={project._id}>{project.name}</option>)}
        </select></label>
        {tab === 'status' && <label className="field"><span>Status</span><select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option><option value="incomplete">Incomplete</option><option value="complete">Complete</option>
        </select></label>}
        {tab === 'member' && data?.slackEnabled && <button className="btn" type="button" onClick={send} disabled={sending || loading || !entries.length}>
          <Send size={16} /> {sending ? 'Sending…' : 'Send to Slack'}
        </button>}
      </div>
      <ErrorBox error={error || slackError} />
    </div>
    {loading ? <Skeleton /> : !error && (!entries.length ? <div className="card"><Empty title="No daily work matches these filters" /></div> :
      tab === 'status' ? <div className="stack" aria-label="Task statuses">
        {entries.map((entry) => <TaskStatusRow key={entry._id} entry={entry} me={me} onSaved={reload} />)}
      </div> : tab === 'summary' ? <>
        <div className="daily-metrics">
          <div className="card daily-card"><span>Logged hours</span><strong>{totalHours(entries)}</strong></div>
          <div className="card daily-card"><span>Tasks</span><strong>{entries.length}</strong></div>
          <div className="card daily-card"><span>Completed tasks</span><strong>{entries.filter((entry) => entry.status === 'complete').length}</strong></div>
        </div>
        <div className="card table-wrap"><table className="table"><thead><tr><th>Project</th><th>Tasks</th><th>Hours</th></tr></thead>
          <tbody>{Array.from(projects, ([id, group]) => <tr key={id}><td>{group.name}</td><td>{group.count}</td><td>{hours(group.hours)}</td></tr>)}</tbody></table></div>
      </> : <div className="card table-wrap"><table className="table">
        <thead><tr><th>Member</th><th>Date</th><th>Project</th><th>Task</th><th>Hours</th><th>Priority</th><th>Status</th><th aria-label="Actions" /></tr></thead>
        <tbody>{entries.map((entry) => <tr key={entry._id}><td>{entry.submission.memberName}</td><td>{entry.submission.date}</td><td>{entry.projectName}</td>
          <td>{entry.title}{entry.note && <p className="small muted daily-task-description">{entry.note}</p>}</td><td>{hours(entry.hours)}</td><td className="daily-status">{entry.priority}</td>
          <td><StatusBadge entry={entry} /></td>
          <td>{entry.submission.memberId === me && <button className="btn btn-sm" onClick={() => { setDate(entry.submission.date); openEntry(); }}>Edit day</button>}</td>
        </tr>)}</tbody>
      </table></div>)}
  </div>;
}

function Missing({ date }) {
  const { data, error, loading } = useApi(`${root}/missing/${date}`);
  if (loading) return <Skeleton />;
  if (error) return <ErrorBox error={error} />;
  return <div className="card daily-card stack">
    <h2>Missing Report</h2>
    <p className="muted">{data.missing.length} of {data.expected} expected employees have yet to submit.</p>
    {!data.expected ? <Empty title="No submissions expected" /> :
      !data.missing.length ? <Empty title="All expected employees submitted" /> :
      <div className="table-wrap"><table className="table"><thead><tr><th>Employee</th><th>Shift</th></tr></thead>
        <tbody>{data.missing.map((member) => <tr key={member.id}><td>{member.name}</td><td className="daily-status">{member.shift}</td></tr>)}</tbody>
      </table></div>}
  </div>;
}

function Hubstaff({ date }) {
  const { data, error, loading, reload } = useApi(`${root}/hubstaff/${date}`);
  return <div className="card daily-card stack">
    <div className="row-wrap daily-header"><h2>Hubstaff</h2><button className="btn" onClick={reload}>Refresh</button></div>
    <p className="muted">Hours are for the selected date. Current Project shows the latest project for members Hubstaff reports as online.</p>
    <ErrorBox error={error} />
    {loading ? <Skeleton /> : !error && (data.rows.length ? <div className="table-wrap"><table className="table"><thead>
      <tr><th>Employee</th><th>Tracked hours</th><th>Last activity</th><th>Current Project</th></tr></thead>
      <tbody>{data.rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{hours(row.hours)}</td>
        <td>{row.lastActivity ? new Date(row.lastActivity).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td><td>{row.currentProject || '—'}</td>
      </tr>)}</tbody></table></div> : <Empty title="No Hubstaff members mapped" />)}
  </div>;
}

export default function DailyWork() {
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(today);
  const { user, can } = useAuth();
  const day = useApi(`${root}/day/${date}`);
  const tabs = [['entry', 'Add Projects'], ['member', 'Projects by Member'], ['status', 'Task Status'],
    ['summary', 'Summary Dashboard'], ['missing', 'Missing Report']];
  if (can.super || day.data?.hubstaffAccess) tabs.push(['hubstaff', 'Hubstaff']);
  if (can.super) tabs.push(['manage', 'Manage Data']);
  const requested = params.get('tab');
  const tab = tabs.some(([id]) => id === requested) ? requested : 'entry';
  const choose = (id) => {
    if (id === 'entry' && tab !== 'entry') day.reload();
    setParams(id === 'entry' ? {} : { tab: id });
  };
  return <div className="daily-work-page" data-entry={tab === 'entry' ? '' : undefined}>
    <PageHead title="Daily Work">
      {['entry', 'missing', 'hubstaff'].includes(tab) && <DateField value={date} onChange={setDate} />}
    </PageHead>
    <nav className="daily-tabs" aria-label="Daily Work">
      {tabs.map(([id, label]) => <button key={id} type="button" className={`daily-tab ${id === tab ? 'active' : ''}`}
        aria-current={id === tab ? 'page' : undefined} onClick={() => choose(id)}>{label}</button>)}
    </nav>
    {tab === 'entry' && (day.error ? <ErrorBox error={day.error} /> : day.loading || day.data?.date !== date ? <Skeleton /> :
      <EntryEditor key={date} date={date} data={day.data} />)}
    {reportViews.includes(tab) && <DailyReports tab={tab} date={date} setDate={setDate} openEntry={() => choose('entry')} me={user._id} />}
    {tab === 'missing' && <Missing date={date} />}
    {tab === 'hubstaff' && <Hubstaff date={date} />}
    {tab === 'manage' && <ManageDailyWork onSaved={day.reload} />}
  </div>;
}

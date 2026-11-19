import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus, Search, Send, Trash2 } from 'lucide-react';
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
  skipped: 'Saved.',
};

function DateField({ value, onChange, label = 'Work date' }) {
  return <label className="field"><span>{label}</span><input className="input" type="date" max={today()} value={value}
    onChange={(event) => event.target.value && onChange(event.target.value)} /></label>;
}

function EntryEditor({ date, data, onSaved }) {
  const [submission, setSubmission] = useState(data.submission);
  const [rows, setRows] = useState(() => (data.submission?.entries || []).map((entry) => ({ ...entry, key: entry._id })));
  const [project, setProject] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const editor = useRef(null);
  const newEntry = useRef(null);
  const toast = useToast();
  useEffect(() => {
    if (!newEntry.current) return;
    const row = editor.current?.querySelector(`[data-entry-key="${newEntry.current}"]`);
    const field = row?.querySelector('[data-entry-focus]');
    newEntry.current = null;
    field?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [rows]);
  const projectLabel = (item) => item.clientName && item.clientName !== item.name ? `${item.clientName} / ${item.name}` : item.name;
  const filtered = data.projects.filter((item) => nameKey(projectLabel(item)).includes(nameKey(search)));
  const selected = data.projects.find((item) => item._id === project);
  const projectIds = new Set(filtered.map((item) => item._id));
  const visibleSuggestions = data.suggestions.filter((suggestion) =>
    (selected ? suggestion.projectId === selected._id : projectIds.has(suggestion.projectId)) &&
    !rows.some((row) => row.workflowTaskId === suggestion.id));
  const update = (key, patch) => setRows((old) => old.map((row) => row.key === key ? { ...row, ...patch } : row));

  function taskFor(row) {
    return data.catalog.find((task) => task.projectId === row.projectId &&
      (task._id === row.catalogId || nameKey(task.title) === nameKey(row.title)));
  }

  function available(task, excludedKey) {
    const used = rows.reduce((sum, row) => {
      if (row.key === excludedKey) return sum;
      const matches = task.review ? nameKey(row.title) === 'review' : taskFor(row)?._id === task._id;
      return matches ? sum + Math.round(Number(row.hours || 0) * 100) : sum;
    }, 0);
    return Math.max(0, Math.round(task.remainingHours * 100) - used) / 100;
  }

  function add(item, suggestion) {
    if (!item || rows.length >= 40) return;
    const assignment = data.assignments.find((row) => row.projectId === item._id);
    const task = suggestion && taskFor({ projectId: item._id, title: suggestion.title });
    const key = crypto.randomUUID();
    newEntry.current = key;
    setRows((old) => [...old, {
      key, projectId: item._id, projectName: item.name, title: task?.title || suggestion?.title || '',
      catalogId: task?._id, workflowTaskId: suggestion?.id, workItemId: suggestion?.workItemId,
      checklist: suggestion?.checklist, workflowStatus: suggestion?.workflowStatus,
      hours: task ? Math.min(assignment?.hours ?? task.hours, available(task), 24) : assignment?.hours ?? '',
      priority: suggestion?.priority || 'normal', status: 'incomplete',
    }]);
  }

  function chooseTask(row, id) {
    const master = data.workItems.find((item) => item.id === id && item.projectId === row.projectId);
    const task = master ? taskFor({ projectId: row.projectId, title: master.title }) : data.catalog.find((item) => item._id === id);
    const occurrence = master && data.suggestions.find((item) => item.workItemId === id && item.projectId === row.projectId);
    update(row.key, {
      catalogId: task?._id, workItemId: master?.id, workflowTaskId: occurrence?.id,
      title: master?.title || task?.title || '', hours: task ? Math.min(task.hours, available(task, row.key), 24) : master?.hours ?? '',
      checklist: occurrence?.checklist, workflowStatus: occurrence?.workflowStatus, checklistChanges: undefined, status: 'incomplete',
    });
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api(`${root}/day/${date}`, {
        method: 'PUT', body: { entries: rows.map(({ key, ...row }) => {
          // React row keys are local to this editor.
          void key;
          return row;
        }), version: submission?.version },
      });
      setSubmission(response);
      setRows(response.entries.map((entry) => ({ ...entry, key: entry._id })));
      toast(deliveryLabel[response.delivery] || 'Saved.');
      onSaved();
    } catch (error) { setError(error); }
    finally { setBusy(false); }
  }

  return <div className="daily-entry-layout">
    <section className="card daily-card daily-project-picker" aria-labelledby="daily-project-heading">
      <div className="row-wrap daily-header"><h2 id="daily-project-heading">Daily entry</h2><Badge cls="b-primary">{data.memberName}</Badge></div>
      <div className="stack daily-picker-fields">
        <label className="field"><span>Find a project</span>
          <span className="daily-search"><Search size={17} aria-hidden="true" /><input className="input" type="search" placeholder="Search by client or project" value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              if (selected && !nameKey(projectLabel(selected)).includes(nameKey(value))) setProject('');
            }} /></span>
        </label>
        <div className="field"><label htmlFor="daily-project">Project</label><select id="daily-project" className="select" value={filtered.some((item) => item._id === project) ? project : ''}
          onChange={(event) => setProject(event.target.value)}>
          <option value="">Select a project</option>
          {filtered.map((item) => <option key={item._id} value={item._id}>{projectLabel(item)}</option>)}
        </select></div>
        <button type="button" className="btn btn-tonal daily-add-project" onClick={() => add(selected)}
          disabled={!selected || !projectIds.has(project) || busy || rows.length >= 40}><Plus size={16} /> Add task</button>
      </div>
      {!data.projects.length && <p className="small muted">Client projects you have access to appear here automatically.</p>}
      {!!data.projects.length && !filtered.length && <p className="small muted">No projects match your search.</p>}
    </section>
    <form ref={editor} onSubmit={submit} className="card daily-task-editor" aria-labelledby="daily-selected-heading">
      <div className="row-wrap daily-header daily-editor-bar">
        <div><h2 id="daily-selected-heading">Selected tasks</h2><p className="small muted">{dueLabel.format(new Date(`${date}T00:00:00+05:30`))}</p></div>
        <div className="row-wrap daily-editor-totals" aria-live="polite">
          <span className="small muted">{rows.length} {rows.length === 1 ? 'task' : 'tasks'}</span>
          <Badge cls="b-primary"><span className="mono">{totalHours(rows)} h</span></Badge>
        </div>
      </div>
      <div className="daily-editor-body stack">
        <ErrorBox error={error} />
        {!rows.length && <Empty icon={ClipboardList} title="No tasks selected">Select a project and add a task, or pick a Workflow suggestion.</Empty>}
        {rows.map((row) => {
          const shared = data.workItems.filter((item) => item.projectId === row.projectId);
          const linked = !!row._id && !!row.workflowTaskId;
          const catalog = data.catalog.filter((item) => item.projectId === row.projectId &&
            !shared.some((reference) => nameKey(reference.title) === nameKey(item.title)));
          const task = taskFor(row);
          const remaining = task && available(task, row.key);
          const original = submission?.entries.find((entry) => entry._id === row._id);
          const existingHours = original && task &&
            (original.catalogId === task._id || nameKey(original.title) === nameKey(task.title)) ? original.hours : 0;
          const maxHours = task ? Math.min(24, Math.max(remaining, existingHours)) : 24;
          const hasPicker = !linked && !!(catalog.length || shared.length);
          const showTitle = !hasPicker || !(row.workItemId || row.catalogId);
          return <fieldset className="daily-entry" key={row.key} data-entry-key={row.key} disabled={busy}>
            <legend>{row.projectName}</legend>
            <div className="daily-task-heading">
              <div className="stack daily-task-name">
                {hasPicker && <div className="field"><label htmlFor={`project-task-${row.key}`}>Project task</label>
                  <select id={`project-task-${row.key}`} className="select"
                  data-entry-focus={!row.title || undefined}
                  value={row.workItemId || (catalog.some((item) => item._id === row.catalogId) ? row.catalogId : '')}
                  onChange={(event) => chooseTask(row, event.target.value)}>
                  <option value="">Custom task</option>
                  {shared.map((item) => <option key={item.id} value={item.id} disabled={!item.canLog}>{item.title}</option>)}
                  {catalog.map((item) => <option key={item._id} value={item._id}>{item.title} · {item.hours} h {item.period}</option>)}
                </select>{catalog.find((item) => item._id === row.catalogId)?.description &&
                  <span className="hint">{catalog.find((item) => item._id === row.catalogId).description}</span>}</div>}
                {linked ? <strong className="daily-task-linked">{row.title}</strong> : showTitle && <label className="field"><span>Task</span>
                  <input className="input" maxLength={230} required readOnly={!!row.workItemId || (!!row.catalogId && !!task)} value={row.title}
                    data-entry-focus={(!hasPicker && !row.title) || undefined}
                    onChange={(event) => update(row.key, { title: event.target.value, catalogId: undefined, workflowTaskId: undefined })} /></label>}
              </div>
              <button type="button" className="btn btn-ghost icon-btn daily-task-remove" aria-label={`Remove ${row.title || 'task'}`} title="Remove task"
                onClick={() => setRows((old) => old.filter((item) => item.key !== row.key))}><Trash2 size={17} /></button>
            </div>
            <div className="daily-entry-grid">
              <div className="field">
                <label htmlFor={`hours-${row.key}`}>Hours</label>
                <input id={`hours-${row.key}`} className="input" type="number" min="0" max={maxHours} step="0.01" required value={row.hours}
                  aria-describedby={task ? `hours-limit-${row.key}` : undefined}
                  data-entry-focus={!!row.title || undefined}
                  onChange={(event) => update(row.key, { hours: event.target.value })} />
                {task && <span id={`hours-limit-${row.key}`} className="hint">
                  Up to {hours(remaining)} h · {task.period}{task.review ? ' · across projects' : ''}
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
          </fieldset>;
        })}
      </div>
      <div className="row-wrap daily-header daily-editor-footer">
        <span className="small muted" role="status">{deliveryLabel[submission?.delivery] || ''}</span>
        <button className="btn btn-primary" disabled={busy || (!rows.length && !submission)}>
          <Send size={16} />{busy ? 'Saving…' : submission ? 'Save changes' : data.slackEnabled ? 'Send' : 'Save'}
        </button>
      </div>
    </form>
    <section className="card daily-card daily-suggestion-panel" aria-labelledby="daily-suggestions-heading">
      <div className="row-wrap daily-header">
        <h2 id="daily-suggestions-heading">Workflow suggestions</h2>
        {selected && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setProject(''); setSearch(''); }}>Show all projects</button>}
      </div>
      {!visibleSuggestions.length ? <p className="small muted">No suggested tasks {selected ? 'for this project' : 'for this selection'}.</p> :
        <ul className="daily-suggestions" aria-label="Suggested tasks">
          {visibleSuggestions.map((suggestion) => {
            const item = data.projects.find((project) => project._id === suggestion.projectId);
            if (!item) return null;
            return <li key={suggestion.id} className="daily-suggestion">
              <div className="daily-suggestion-info">
                <strong>{suggestion.title}</strong>
                <span className="small muted">{item.name}{suggestion.dueDate && ` · Due ${dueLabel.format(new Date(suggestion.dueDate))}`}</span>
              </div>
              <button type="button" className="btn btn-tonal btn-sm" aria-label={`Add ${suggestion.title}${suggestion.dueDate ? `, due ${dueLabel.format(new Date(suggestion.dueDate))}` : ''}`}
                disabled={busy || rows.length >= 40} onClick={() => add(item, suggestion)}>
                <Plus size={15} /> Add
              </button>
            </li>;
          })}
        </ul>}
    </section>
  </div>;
}

const reportViews = ['member', 'status', 'summary'];
function DailyReports({ tab, setDate, openEntry, me }) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [memberId, setMember] = useState('');
  const [projectId, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [slackError, setSlackError] = useState(null);
  const toast = useToast();
  const query = new URLSearchParams({ from, to, memberId, projectId, status: tab === 'status' ? status : '' });
  const { data, error, loading } = useApi(`${root}/reports?${query}`);
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
      tab === 'summary' ? <>
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
          <td>{entry.title}</td><td>{hours(entry.hours)}</td><td className="daily-status">{entry.priority}</td>
          <td><Badge cls={entry.status === 'complete' ? 'b-success' : 'b-warning'}>{entry.status === 'complete' ? 'Complete' : entry.workflowStatus === 'pending_review' ? 'Awaiting TL review' : 'Incomplete'}</Badge></td>
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
      <EntryEditor key={date} date={date} data={day.data} onSaved={day.reload} />)}
    {reportViews.includes(tab) && <DailyReports tab={tab} setDate={setDate} openEntry={() => choose('entry')} me={user._id} />}
    {tab === 'missing' && <Missing date={date} />}
    {tab === 'hubstaff' && <Hubstaff date={date} />}
    {tab === 'manage' && <ManageDailyWork onSaved={day.reload} />}
  </div>;
}

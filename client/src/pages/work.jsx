import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, AlertTriangle, CalendarRange, Plus, Search, Users, Clock, CheckCircle2 } from 'lucide-react';
import { useApi, useAuth, dueInfo, STATUS, fmtDate } from '../lib.jsx';
import { Avatar, Badge, Empty, PageHead, Skeleton, TeamTag } from '../ui.jsx';
import { TaskDrawer, TaskForm, TaskListCard, useTaskToggle } from '../tasks.jsx';

function Stat({ icon: Icon, label, value, tone, selected, onClick }) {
  return (
    <button className={`card stat clickable ${selected ? 'selected' : ''}`} onClick={onClick} aria-pressed={selected}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="stat-label">{label}</span>
        <span className="stat-icon" style={{ background: `var(--${tone}-soft)`, color: `var(--${tone})` }}><Icon size={18} /></span>
      </div>
      <span className="stat-value">{value ?? '–'}</span>
    </button>
  );
}

/* ---------- My work (every role) ---------- */

const RECENT_DONE_DAYS = 7;
const recentlyDone = (t) => t.status === 'done' && Date.now() - new Date(t.completedAt || t.updatedAt) < RECENT_DONE_DAYS * 864e5;

export function MyWork() {
  const { user, can } = useAuth();
  // TLs land on their team's work; everyone can switch to just their own tasks
  const [view, setView] = useState(() => (can.manage ? 'clients' : 'mine'));
  const [bucket, setBucket] = useState('active');
  const [client, setClient] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const tasks = useApi(`/tasks?scope=${view === 'clients' ? 'all' : 'mine'}`, [view]);
  const reload = () => tasks.reload();
  const toggle = useTaskToggle(reload);

  const clients = useMemo(() => {
    const m = new Map(); (tasks.data || []).forEach((t) => t.client && m.set(t.client._id, t.client));
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks.data]);

  const filtered = (tasks.data || []).filter((t) => {
    const b = dueInfo(t).bucket;
    // Completed work stays visible for a week so nobody wonders where it went
    if (bucket === 'active' && b === 'done' && !recentlyDone(t)) return false;
    if (bucket !== 'active' && bucket !== 'all' && b !== bucket) return false;
    if (client && t.client?._id !== client) return false;
    if (q && !`${t.title} ${t.client?.name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const count = (b) => (tasks.data ? tasks.data.filter((t) => dueInfo(t).bucket === b && (!client || t.client?._id === client)).length : undefined);
  const m = { dueToday: count('today'), overdue: count('overdue'), upcoming: count('upcoming'), done: (tasks.data || []).filter(recentlyDone).length };
  const hour = new Date().getHours();
  const pick = (b) => setBucket((cur) => (cur === b ? 'active' : b));

  return (
    <>
      <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${user.name.split(' · ').pop().split(' ')[0]}`}
        subtitle={view === 'clients' ? 'Work across your clients — owners, due dates and progress.' : 'Everything assigned to you across your clients.'}>
        {can.manage && (
          <div className="chips" role="tablist" aria-label="Whose work">
            <button className={`chip ${view === 'clients' ? 'on' : ''}`} role="tab" aria-selected={view === 'clients'} onClick={() => setView('clients')}><Users size={16} />Client work</button>
            <button className={`chip ${view === 'mine' ? 'on' : ''}`} role="tab" aria-selected={view === 'mine'} onClick={() => setView('mine')}>Assigned to me</button>
          </div>
        )}
        {can.manage && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} />New task</button>}
      </PageHead>
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <Stat icon={CalendarClock} label="Due today" value={m?.dueToday} tone="warning" selected={bucket === 'today'} onClick={() => pick('today')} />
        <Stat icon={AlertTriangle} label="Overdue" value={m?.overdue} tone="danger" selected={bucket === 'overdue'} onClick={() => pick('overdue')} />
        <Stat icon={CalendarRange} label="Upcoming" value={m?.upcoming} tone="primary" selected={bucket === 'upcoming'} onClick={() => pick('upcoming')} />
        <Stat icon={CheckCircle2} label={`Done · last ${RECENT_DONE_DAYS} days`} value={tasks.data ? m.done : undefined} tone="success" selected={bucket === 'done'} onClick={() => pick('done')} />
      </div>
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        <select className="select" style={{ maxWidth: 280 }} value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter by client">
          <option value="">All clients</option>{clients.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
        <div className="spacer" />
        <select className="select" style={{ width: 'auto', minHeight: 40, borderRadius: 999 }} value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Show">
          <option value="active">Open + recently done</option><option value="today">Due today</option><option value="overdue">Overdue</option>
          <option value="upcoming">Upcoming</option><option value="done">Completed</option><option value="all">All</option>
        </select>
        <div className="search" style={{ width: 240 }}><Search size={16} /><input className="input" placeholder="Search tasks or clients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" /></div>
      </div>
      <TaskListCard tasks={filtered} loading={tasks.loading} showPeople={view === 'clients'} onOpen={(t) => setOpenId(t._id)} onToggle={toggle}
        emptyTitle={bucket === 'overdue' ? 'Nothing overdue — nice work' : 'No tasks match'} />
      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
      {creating && <TaskForm onClose={() => setCreating(false)} onSaved={reload} />}
    </>
  );
}

/* ---------- Client manager dashboard ---------- */

function ManagerOverview() {
  const clients = useApi('/clients');
  const tasks = useApi('/tasks?scope=all');
  const [clientId, setClientId] = useState('');
  const [personId, setPersonId] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [openId, setOpenId] = useState(null);
  const managed = (clients.data || []).filter((c) => c.canManage);
  const managedIds = new Set(managed.map((c) => c._id));
  const allowed = (tasks.data || []).filter((t) => managedIds.has(t.client?._id));
  const scoped = clientId ? allowed.filter((t) => t.client?._id === clientId) : allowed;
  const peopleMap = new Map();
  for (const t of scoped) for (const p of (t.assignees || [])) {
    if (!peopleMap.has(p._id)) peopleMap.set(p._id, { ...p, pending: 0, completed: 0, overdue: 0, today: 0 });
    const row = peopleMap.get(p._id);
    if (t.status === 'done') row.completed += 1;
    else {
      row.pending += 1;
      const bucket = dueInfo(t).bucket;
      if (bucket === 'overdue') row.overdue += 1;
      if (bucket === 'today') row.today += 1;
    }
  }
  const people = [...peopleMap.values()].sort((a, b) => b.overdue - a.overdue || b.pending - a.pending || a.name.localeCompare(b.name));
  const personTasks = personId ? scoped.filter((t) => t.assignees.some((a) => a._id === personId)) : scoped;
  const filtered = personTasks.filter((t) => {
    if (statusFilter === 'completed') return t.status === 'done';
    if (statusFilter === 'due') return t.status !== 'done' && ['today', 'overdue'].includes(dueInfo(t).bucket);
    return t.status !== 'done';
  });
  const totalDone = scoped.filter((t) => t.status === 'done').length;
  const totalPending = scoped.length - totalDone;
  const overdueCount = scoped.filter((t) => t.status !== 'done' && dueInfo(t).bucket === 'overdue').length;
  const todayCount = scoped.filter((t) => t.status !== 'done' && dueInfo(t).bucket === 'today').length;
  const selectedName = people.find((p) => p._id === personId)?.name;

  return <>
    <PageHead title="Manager overview" subtitle="Track pending and completed work for the clients you manage." />
    <div className="row-wrap" style={{ marginBottom: 20, gap: 12 }}>
      <select className="select" aria-label="Select client" style={{ maxWidth: 360 }} value={clientId} onChange={(e) => { setClientId(e.target.value); setPersonId(''); }}>
        <option value="">All my clients</option>
        {managed.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
      </select>
      <span className="small muted">{managed.length} managed clients</span>
    </div>
    <div className="grid grid-4" style={{ marginBottom: 20 }}>
      <div className="card card-pad"><div className="small muted">Pending tasks</div><h2>{totalPending}</h2></div>
      <div className="card card-pad"><div className="small muted">Due today</div><h2>{todayCount}</h2></div>
      <div className="card card-pad"><div className="small muted">Overdue</div><h2>{overdueCount}</h2></div>
      <div className="card card-pad"><div className="small muted">Completed tasks</div><h2>{totalDone}</h2></div>
    </div>
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head"><h3>Employee workload</h3><span className="small muted">Click a person to review their tasks</span></div>
      {clients.loading || tasks.loading ? <Skeleton /> : people.length === 0 ? <Empty icon={Users} title="No tasks assigned for these clients" /> :
        <div className="table-wrap"><table>
          <thead><tr><th>Employee</th><th>Pending</th><th>Due today</th><th>Overdue</th><th>Completed</th></tr></thead>
          <tbody>{people.map((p) => <tr key={p._id} className="clickable" style={personId === p._id ? { background: 'var(--primary-soft)' } : undefined} onClick={() => setPersonId((old) => old === p._id ? '' : p._id)}>
            <td><span className="row"><Avatar name={p.name} size="sm"/>{p.name}</span></td>
            <td className="mono">{p.pending}</td><td className="mono">{p.today}</td>
            <td>{p.overdue ? <Badge cls="b-danger">{p.overdue}</Badge> : '0'}</td>
            <td><Badge cls="b-success">{p.completed}</Badge></td>
          </tr>)}</tbody>
        </table></div>
      }
    </div>
    <div className="row-wrap" style={{ marginBottom: 12 }}>
      <h3>{selectedName ? `Tasks · ${selectedName}` : 'Client tasks'}</h3>
      <div className="spacer" />
      {personId && <button className="btn btn-ghost btn-sm" onClick={() => setPersonId('')}>All employees</button>}
      <div className="chips">
        {[['due','Due now'], ['pending','All pending'], ['completed','Completed']].map(([id, label]) =>
          <button key={id} className={`chip ${statusFilter === id ? 'on' : ''}`} onClick={() => setStatusFilter(id)}>{label}</button>
        )}
      </div>
    </div>
    <TaskListCard tasks={filtered} loading={tasks.loading} showPeople={!personId} onOpen={(t) => setOpenId(t._id)} emptyTitle="No tasks for this selection" />
    {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={tasks.reload} />}
  </>;
}

/* ---------- Overview (Admin / Super Admin) ---------- */

function GlobalOverview() {
  const { can } = useAuth();
  const dash = useApi('/dashboard');
  const all = useApi('/tasks?scope=all&status=todo,in_progress,waiting');
  const [openId, setOpenId] = useState(null);
  const [person, setPerson] = useState('');
  const d = dash.data;
  const statusTotal = (d?.byStatus || []).reduce((a, s) => a + s.n, 0) || 1;
  const statusColor = { todo: 'var(--text-3)', in_progress: 'var(--info)', waiting: 'var(--warning)', done: 'var(--success)' };
  const actionable = (all.data || []).filter((t) => ['today', 'overdue'].includes(dueInfo(t).bucket));
  const overdue = actionable.filter((t) => dueInfo(t).bucket === 'overdue');
  const shown = person ? actionable.filter((t) => t.assignees.some((a) => a._id === person)) : overdue;

  return (
    <>
      <PageHead title="Overview" subtitle={can.super ? 'Workload across every client.' : 'Workload for the clients you manage.'} />
      {!d ? <div className="card"><Skeleton /></div> : (
        <div className="split">
          <div className="stack" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-head"><h3>Workload by person</h3><span className="small muted">Open workload · select a person to see today’s and overdue tasks</span></div>
              {d.byPerson.length === 0 ? <Empty icon={Users} title="No open work" /> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Person</th><th>Today</th><th>Overdue</th><th style={{ width: '40%' }}>Open</th></tr></thead>
                  <tbody>
                    {d.byPerson.map((p) => {
                      const max = Math.max(...d.byPerson.map((x) => x.open));
                      return (
                        <tr key={p._id} className="clickable" onClick={() => setPerson(person === p._id ? '' : p._id)} style={person === p._id ? { background: 'var(--primary-soft)' } : undefined}>
                          <td><span className="row"><Avatar name={p.name} size="sm" />{p.name}</span></td>
                          <td className="mono">{p.today}</td>
                          <td>{p.overdue ? <Badge cls="b-danger">{p.overdue}</Badge> : <span className="muted">0</span>}</td>
                          <td><div className="row"><div className="bar" style={{ flex: 1 }}><span style={{ width: `${(p.open / max) * 100}%`, background: 'var(--primary)' }} /></div><span className="mono small" style={{ width: 24, textAlign: 'right' }}>{p.open}</span></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              )}
            </div>
            <div>
              <div className="row" style={{ margin: '8px 0 12px' }}>
                <h3>{person ? `Due now · ${d.byPerson.find((p) => p._id === person)?.name}` : 'Overdue work'}</h3>
                {person && <button className="btn btn-ghost btn-sm" onClick={() => setPerson('')}>Show overdue</button>}
              </div>
              <TaskListCard tasks={shown} loading={all.loading} groups={!!person} onOpen={(t) => setOpenId(t._id)} emptyTitle={person ? "No tasks due today or overdue" : "Nothing overdue"} />
            </div>
          </div>
          <div className="stack" style={{ gap: 16 }}>
            <div className="card card-pad">
              <h3 style={{ marginBottom: 4 }}>Status mix</h3><p className="small muted" style={{ marginBottom: 14 }}>Tasks due up to 7 days ahead</p>
              <div className="bar" style={{ height: 12, marginBottom: 14 }}>
                {d.byStatus.map((s) => <span key={s._id} style={{ width: `${(s.n / statusTotal) * 100}%`, background: statusColor[s._id] }} title={`${STATUS[s._id]?.label}: ${s.n}`} />)}
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {Object.keys(STATUS).map((k) => (
                  <div key={k} className="row"><span className="team-dot" style={{ background: statusColor[k] }} />{STATUS[k].label}<div className="spacer" /><span className="mono">{d.byStatus.find((s) => s._id === k)?.n || 0}</span></div>
                ))}
              </div>
            </div>
            <div className="card"><div className="card-head"><h3>By client</h3></div><div className="list">
              {(d.byClient || []).map((c) => <div key={c._id || 'none'} className="list-item" style={{ cursor: 'default' }}>
                <div className="li-main"><strong>{c.name || 'Unassigned client'}</strong></div>
                {c.overdue > 0 && <Badge cls="b-danger">{c.overdue} overdue</Badge>}<span className="mono">{c.open} open</span>
              </div>)}
            </div></div>
            <div className="card">
              <div className="card-head"><h3>Access expiring soon</h3><Clock size={16} className="muted" /></div>
              {d.expiringSoon.length === 0 ? <p className="small muted" style={{ padding: 20 }}>No temporary access ends in the next 7 days.</p> : (
                <div className="list">{d.expiringSoon.map((p) => (
                  <div key={p._id} className="list-item" style={{ cursor: 'default' }}>
                    <Avatar name={p.user.name} size="sm" /><div className="li-main"><div className="title">{p.user.name}</div><div className="li-meta">{p.client.name}</div></div>
                    <Badge cls="b-warning">{fmtDate(p.expiresAt)}</Badge>
                  </div>
                ))}</div>
              )}
            </div>
          </div>
        </div>
      )}
      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => { all.reload(); dash.reload(); }} />}
    </>
  );
}

export function Overview() {
  const { can } = useAuth();
  return can.super ? <GlobalOverview /> : <ManagerOverview />;
}

export function useGoto() { const nav = useNavigate(); return (p) => () => nav(p); }

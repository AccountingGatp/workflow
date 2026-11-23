import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Clock } from 'lucide-react';
import { useApi, usePaginatedTasks, useAuth, STATUS, fmtDate } from '../lib.jsx';
import { Avatar, Badge, Empty, ErrorBox, PageHead, Skeleton } from '../ui.jsx';
import { TaskDrawer, TaskListCard, TaskPagination } from '../tasks.jsx';
import { DailyTaskStatus } from './daily-work.jsx';

/* ---------- My work (every role) ---------- */

export function MyWork() {
  const { user } = useAuth();
  const hour = new Date().getHours();
  return <>
    <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${user.name.split(' · ').pop().split(' ')[0]}`} />
    <section className="stack" aria-labelledby="my-work-task-status">
      <h2 id="my-work-task-status">Daily task completion</h2>
      <DailyTaskStatus />
    </section>
  </>;
}

/* ---------- Client manager dashboard ---------- */

function ManagerOverview() {
  const clients = useApi('/clients');
  const projects = useApi('/projects');
  const [clientId, setClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [personId, setPersonId] = useState('');
  const [statusFilter, setStatusFilter] = useState('due');
  const [openId, setOpenId] = useState(null);
  const managed = (clients.data || []).filter(c => c.canManage);
  const { user } = useAuth();
  const availableProjects = (projects.data || []).filter((project) =>
    (user.role === 'admin' || project.canManage) && (!clientId || project.client === clientId));
  const selectedProject = availableProjects.find((project) => project._id === projectId);
  const workload = useApi(`/manager-workload?client=${clientId}&project=${projectId}`, [clientId, projectId]);
  const people = workload.data?.people || [];
  const totals = workload.data?.totals || {};
  const byProject = workload.data?.byProject || [];
  const query = `scope=managed&client=${clientId}&project=${projectId}&assignee=${personId}&view=${statusFilter}`;
  const tasks = usePaginatedTasks(query);
  const refresh = () => { tasks.reload(); workload.reload(); };
  const selectedName = people.find(p => p._id === personId)?.name;
  const number = key => workload.data ? totals[key] || 0 : '—';
  return <>
    <PageHead title="Manager overview" subtitle="Deadlines, employee progress and workload for the projects you can manage." />
    <div className="row-wrap" style={{ marginBottom: 18, gap: 12 }}>
      <select className="select" aria-label="Select client" style={{ maxWidth: 360 }} value={clientId} onChange={e => { setClientId(e.target.value); setProjectId(''); setPersonId(''); }}>
        <option value="">All clients</option>
        {managed.map(c => <option key={c._id} value={c._id}>{c.name}</option>)}
      </select>
      <select className="select" aria-label="Select project" style={{ maxWidth: 310 }} value={projectId} onChange={e => { setProjectId(e.target.value); setPersonId(''); }}>
        <option value="">All projects</option>
        {availableProjects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        {clientId && <option value="unassigned">Needs project assignment</option>}
      </select>
      {user.role === 'manager' && selectedProject && <Link className="btn" to={`/clients/${selectedProject.client}/projects/${selectedProject._id}?insights=1`}>View project insights</Link>}
    </div>
    <ErrorBox error={workload.error || projects.error} />
    <div className="grid grid-4" style={{ marginBottom: 12 }}>
      <div className="card card-pad"><div className="small muted">Due now (today + overdue)</div><h2>{number('dueNow')}</h2></div>
      <div className="card card-pad"><div className="small muted">Due today</div><h2>{number('today')}</h2></div>
      <div className="card card-pad"><div className="small muted">Overdue</div><h2>{number('overdue')}</h2></div>
      <div className="card card-pad"><div className="small muted">Completed · last 7 days</div><h2>{number('completedRecent')}</h2></div>
    </div>
    <p className="small muted" style={{ marginBottom: 20 }}>
      {workload.data ? `${totals.pending || 0} unfinished scheduled occurrences in total, including ${totals.future || 0} future occurrences; ${totals.completed || 0} completed occurrences in history.` : 'Loading workload totals…'}
      {' '}Future daily tasks are not shown in the actionable task list.
    </p>
    <div className="grid grid-2" style={{ marginBottom: 20 }}>
      <div className="card card-pad">
        <div className="small muted">Master work items</div>
        <h2>{workload.data ? workload.data.masterItems : '—'}</h2>
        <p className="small muted">Scope and SOP reference items. These are not dated employee tasks.</p>
      </div>
      <div className="card card-pad">
        <div className="small muted">Recurring schedules</div>
        <h2>{workload.data ? workload.data.activeSchedules : '—'}</h2>
        <p className="small muted">{workload.data ? `${workload.data.recurringSchedules} total, including paused schedules` : 'Loading…'}</p>
      </div>
    </div>
    {clientId && !projectId && byProject.length > 0 && <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head"><h3>Work by project</h3><span className="small muted">Click a project to view its work</span></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Project</th><th>Due now</th><th>Future</th><th>Completed</th></tr></thead>
        <tbody>{byProject.map(p => <tr key={p._id || 'unassigned'} className="clickable" onClick={() => { setProjectId(p._id || 'unassigned'); setPersonId(''); }}>
          <td><strong>{p.name}</strong></td><td className="mono">{p.dueNow || 0}</td><td className="mono">{p.future || 0}</td><td className="mono">{p.completed || 0}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head"><h3>Employee workload</h3><span className="small muted">Select an employee to review assigned work</span></div>
      {clients.loading || workload.loading ? <Skeleton /> : people.length === 0 ? <Empty icon={Users} title="No task occurrences assigned for this selection" /> :
        <div className="table-wrap"><table>
          <thead><tr><th>Employee</th><th>Due now</th><th>Due today</th><th>Overdue</th><th>Future</th><th>Completed · 7 days</th></tr></thead>
          <tbody>{people.map(p => <tr key={p._id} className="clickable" style={personId === p._id ? { background: 'var(--primary-soft)' } : undefined} onClick={() => setPersonId(old => old === p._id ? '' : p._id)}>
            <td><span className="row"><Avatar name={p.name} size="sm"/>{p.name}</span></td>
            <td className="mono">{p.dueNow}</td><td className="mono">{p.today}</td>
            <td>{p.overdue ? <Badge cls="b-danger">{p.overdue}</Badge> : '0'}</td>
            <td className="mono">{p.future}</td>
            <td><Badge cls="b-success">{p.completedRecent}</Badge></td>
          </tr>)}</tbody>
        </table></div>
      }
    </div>
    <div className="row-wrap" style={{ marginBottom: 12 }}>
      <h3>{selectedName ? `Tasks · ${selectedName}` : 'Scheduled task occurrences'}</h3><div className="spacer" />
      {personId && <button className="btn btn-ghost btn-sm" onClick={() => setPersonId('')}>All employees</button>}
      <div className="chips">
        {[['due','Due now'], ['pending','Actionable'], ['upcoming','Weekly/monthly · next 7 days'], ['completed','Completed history']].map(([id,label]) =>
          <button key={id} className={`chip ${statusFilter === id ? 'on' : ''}`} onClick={() => setStatusFilter(id)}>{label}</button>
        )}
      </div>
    </div>
    <TaskListCard tasks={tasks.data} loading={tasks.loading} showPeople={!personId} onOpen={t => setOpenId(t._id)} emptyTitle="No scheduled tasks for this selection" />
    <TaskPagination {...tasks} />
    {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
  </>;
}

/* ---------- Overview (Admin / Super Admin) ---------- */

function GlobalOverview() {
  const { can } = useAuth();
  const dash = useApi('/dashboard');
  const [openId, setOpenId] = useState(null);
  const [person, setPerson] = useState('');
  const all = usePaginatedTasks(`scope=all&view=${person ? 'due' : 'overdue'}&assignee=${person}`);
  const d = dash.data;
  const statusTotal = (d?.byStatus || []).reduce((a, s) => a + s.n, 0) || 1;
  const statusColor = { todo: 'var(--text-3)', in_progress: 'var(--info)', waiting: 'var(--warning)', pending_review: 'var(--warning)', done: 'var(--success)' };

  return (
    <>
      <PageHead title="Overview" subtitle="Workload across every client." />
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
              <TaskListCard tasks={all.data} loading={all.loading} groups={!!person} onOpen={(t) => setOpenId(t._id)} emptyTitle={person ? "No tasks due today or overdue" : "Nothing overdue"} />
              <TaskPagination {...all} />
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
            {can.super && <div className="card">
              <div className="card-head"><h3>Access expiring soon</h3><Clock size={16} className="muted" /></div>
              {d.expiringSoon.length === 0 ? <p className="small muted" style={{ padding: 20 }}>No temporary access ends in the next 7 days.</p> : (
                <div className="list">{d.expiringSoon.map((p) => (
                  <div key={p._id} className="list-item" style={{ cursor: 'default' }}>
                    <Avatar name={p.user.name} size="sm" /><div className="li-main"><div className="title">{p.user.name}</div><div className="li-meta">{p.client.name}</div></div>
                    <Badge cls="b-warning">{fmtDate(p.expiresAt)}</Badge>
                  </div>
                ))}</div>
              )}
            </div>}
          </div>
        </div>
      )}
      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => { all.reload(); dash.reload(); }} />}
    </>
  );
}

export function Overview() {
  const { can } = useAuth();
  return can.super || can.hr ? <GlobalOverview /> : <ManagerOverview />;
}

export function useGoto() { const nav = useNavigate(); return (p) => () => nav(p); }

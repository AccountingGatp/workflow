import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Building2, FolderKanban, Plus, Search, ArrowLeft, ShieldCheck, Trash2, Mail, Phone, Hash, UserPlus, Clock, X } from 'lucide-react';
import { api, useApi, usePaginatedTasks, useAuth, useToast, fmtDate, toInputDate, ROLE_LABEL } from '../lib.jsx';
import { Avatar, Avatars, Badge, Empty, ErrorBox, Field, Modal, PageHead, Skeleton, TeamTag } from '../ui.jsx';
import { TaskDrawer, TaskForm, TaskListCard, TaskPagination, useTaskToggle } from '../tasks.jsx';
import { ProjectAssignment } from '../project-assignment.jsx';
import { NewProjectForm } from './projects.jsx';

const STATUS_CLS = { active: 'b-success', onboarding: 'b-info', inactive: '' };

export function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const clientView = params.get('view') === 'clients';
  const clients = useApi('/clients');
  const projects = useApi(clientView ? null : '/projects');
  const [projectQuery, setProjectQuery] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [creating, setCreating] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const source = clientView ? clients : projects;
  const query = clientView ? clientQuery : projectQuery;
  const setQuery = clientView ? setClientQuery : setProjectQuery;
  const search = query.trim().toLowerCase();
  const rows = (source.data || []).filter((row) => {
    const context = clientView ? row.accountingId : row.clientName;
    return (!clientView || !row.standaloneProject) && `${row.name} ${context || ''}`.toLowerCase().includes(search);
  });
  const manageableClients = (clients.data || []).filter((client) => client.canManage && !client.standaloneProject);
  const label = clientView ? 'clients' : 'projects';

  return <>
    <PageHead title={clientView ? 'Clients' : 'Projects'} subtitle={clientView ? 'Manage client details and access.' : undefined}>
      {can.manage && <button type="button" className="btn btn-primary"
        onClick={() => setCreating('project')}><Plus size={18} />New project</button>}
      {can.super && <button type="button" className="btn btn-outline" onClick={() => setCreating('client')}><Plus size={16} />New client</button>}
    </PageHead>

    <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
      <nav className="chips" aria-label="Workspace view">
        <button type="button" className={`chip ${clientView ? '' : 'on'}`} aria-pressed={!clientView}
          onClick={() => setParams({})}>Projects</button>
        <button type="button" className={`chip ${clientView ? 'on' : ''}`} aria-pressed={clientView}
          onClick={() => setParams({ view: 'clients' })}>Clients</button>
      </nav>
      <div className="search" style={{ width: 260 }}><Search size={16} aria-hidden="true" />
        <input className="input" placeholder={`Search ${label}`} value={query} onChange={(event) => setQuery(event.target.value)}
          aria-label={`Search ${label}`} />
      </div>
    </div>

    {!clientView && <ErrorBox error={clients.error} />}
    <div className="card" style={{ overflow: 'hidden' }}>
      {source.error ? <ErrorBox error={source.error} /> : source.loading && !source.data ? <Skeleton />
        : rows.length === 0 ? <Empty icon={clientView ? Building2 : FolderKanban} title={search ? `No matching ${label}` : `No ${label} yet`}>
          {!search && !clientView && can.manage ? 'Create a project to start organizing work.' : undefined}
        </Empty> : <div className="table-wrap"><table>
          <thead>{clientView ? <tr><th>Client</th><th>Managers</th><th>Status</th></tr>
            : <tr><th>Project</th><th>Client</th><th>Open work</th>{can.manage && <th>Access</th>}</tr>}</thead>
          <tbody>{rows.map((row) => {
            const destination = clientView ? `/clients/${row._id}` : `/clients/${row.client}/projects/${row._id}`;
            const Icon = clientView ? Building2 : FolderKanban;
            return <tr key={row._id}>
              <td><div className="row" style={{ gap: 12 }}>
                <span className="stat-icon" style={{ background: 'var(--surface-2)', color: 'var(--text-2)' }}><Icon size={18} aria-hidden="true" /></span>
                <div><Link to={destination} style={{ color: 'var(--text)', fontWeight: 600 }}>{row.name}</Link>
                  {clientView && row.accountingId && <div className="small muted">{row.accountingId}</div>}</div>
              </div></td>
              {clientView ? <>
                <td><Avatars people={row.admins} /></td>
                <td><Badge cls={STATUS_CLS[row.status]} dot>{row.status}</Badge></td>
              </> : <>
                <td className="small muted">{row.clientInfoId
                  ? <Link to={`/clients/${row.clientInfoId}`}>{row.clientName}</Link> : 'No client'}</td>
                <td><span className="row-wrap"><span className="mono">{row.openTasks}</span>
                  {row.overdueTasks > 0 && <Badge cls="b-danger">{row.overdueTasks} overdue</Badge>}</span></td>
                {can.manage && <td>{row.canManage && <button type="button" className="btn btn-outline btn-sm"
                  aria-label={`Assign people to ${row.name}`} onClick={() => setAssigning(row)}>
                  <UserPlus size={15} />Assign people
                </button>}</td>}
              </>}
            </tr>;
          })}</tbody>
        </table></div>}
    </div>
    {assigning && <ProjectAssignment project={assigning} onClose={() => setAssigning(null)} />}
    {creating === 'project' && <NewProjectForm clients={manageableClients} onClose={() => setCreating(null)}
      onSaved={(project) => nav(`/clients/${project.client}/projects/${project._id}`)} />}
    {creating === 'client' && <ClientForm onClose={() => setCreating(null)} onSaved={clients.reload} />}
  </>;
}

function ClientForm({ onClose, onSaved }) {
  const users = useApi('/users');
  const toast = useToast();
  const [f, setF] = useState({ name: '', accountingId: '', contactName: '', contactEmail: '', contactPhone: '', status: 'active', adminIds: [] });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const toggle = (k, id) => setF((s) => ({ ...s, [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] }));
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/clients', { method: 'POST', body: f }); toast(`${f.name} created`); onSaved(); onClose(); } catch (err) { setError(err); }
  };
  return (
    <Modal wide title="New client" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="client-form" disabled={!f.name}>Create client</button></>}>
      <form id="client-form" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid grid-2">
          <Field label="Client name"><input className="input" value={f.name} onChange={set('name')} required autoFocus /></Field>
          <Field label="Accounting ID"><input className="input" value={f.accountingId} onChange={set('accountingId')} placeholder="HAM-001" /></Field>
          <Field label="Contact name"><input className="input" value={f.contactName} onChange={set('contactName')} /></Field>
          <Field label="Contact email"><input className="input" type="email" value={f.contactEmail} onChange={set('contactEmail')} /></Field>
        </div>
        <Field label="Client managers (optional)" hint="Select who manages this client."><div className="chips">{(users.data || []).filter((u) => ['manager', 'admin'].includes(u.role)).map((u) => (
          <button type="button" key={u._id} className={`chip ${f.adminIds.includes(u._id) ? 'on' : ''}`} onClick={() => toggle('adminIds', u._id)} style={{ paddingLeft: 4 }}><Avatar name={u.name} size="sm" />{u.name}</button>
        ))}</div></Field>
      </form>
    </Modal>
  );
}

export function ClientDetail() {
  const { can } = useAuth();
  const { id } = useParams();
  const { data: c, error, reload } = useApi(`/clients/${id}`, [id]);
  const [show, setShow] = useState('open');
  const tasks = usePaginatedTasks(`scope=all&client=${id}&view=${show === 'done' ? 'completed' : show}`);
  const projects = useApi(`/clients/${id}/projects`, [id]);
  const hasProjects = (projects.data || []).length > 0;
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editingClient, setEditingClient] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [granting, setGranting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const toast = useToast();
  const toggle = useTaskToggle(tasks.reload);

  if (error) return <div className="card"><Empty icon={ShieldCheck} title={error.status === 403 ? 'You don’t have access to this client' : 'Client not found'}><Link to="/clients?view=clients">Back to clients</Link></Empty></div>;
  if (!c) return <div className="card"><Skeleton rows={6} /></div>;

  const revoke = async (p) => {
    if (!confirm(`Remove ${p.user.name}'s access to ${c.name}?`)) return;
    try { await api(`/clients/${id}/permissions/${p._id}`, { method: 'DELETE' }); toast('Access removed'); reload(); } catch (e) { toast(e.message); }
  };
  const unassign = async (a) => {
    if (!confirm(`Stop ${a.name} managing ${c.name}? Existing tasks and history are kept.`)) return;
    try { await api(`/clients/${id}/assignments/${a.assignmentId}`, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message); }
  };

  return (
    <>
      <Link to="/clients?view=clients" className="row small" style={{ color: 'var(--text-3)', marginBottom: 8 }}><ArrowLeft size={16} />Clients</Link>
      <PageHead title={c.name} subtitle={<span className="row-wrap"><Badge cls={STATUS_CLS[c.status]} dot>{c.status}</Badge></span>}>
        {c.canManage && <button className="btn btn-outline" onClick={() => setEditingClient(true)}>Edit client / company</button>}
        {c.canManage && !can.super && !hasProjects && <button className="btn btn-outline" onClick={() => setRecurring(true)}>Recurring task</button>}
        {c.canManage && !can.super && !hasProjects && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} />New task</button>}
      </PageHead>
      <div className="grid grid-2" style={{ marginBottom: 20 }}>
          <div className="card card-pad stack" style={{ gap: 10 }}>
            <h3>Details</h3>
            <div className="row small"><Hash size={16} className="muted" />{c.accountingId || '—'}</div>
            <div className="row small"><Avatar name={c.contactName || '?'} size="sm" />{c.contactName || '—'}</div>
            {c.contactEmail && <div className="row small"><Mail size={16} className="muted" />{c.contactEmail}</div>}
            {c.contactPhone && <div className="row small"><Phone size={16} className="muted" />{c.contactPhone}</div>}
            {c.canManage && <EmailRules client={c} onSaved={reload} />}
          </div>
          <div className="card">
            <div className="card-head"><h3>Team & managers</h3>{c.isSuper && <button className="btn btn-tonal btn-sm" onClick={() => setAssigning(true)}><Plus size={16} />Assign</button>}</div>
            <div className="list">
              {[...c.teams.map((t) => ({ ...t, kind: 'team' })), ...c.admins.map((a) => ({ ...a, kind: 'admin' }))].map((a) => (
                <div key={a.assignmentId} className="list-item" style={{ cursor: 'default' }}>
                  {a.kind === 'admin' ? <Avatar name={a.name} size="sm" /> : <span className="team-dot" style={{ background: a.color, margin: '0 8px' }} />}
                  <div className="li-main"><div className="title">{a.name}</div><div className="li-meta">{a.kind === 'admin' ? 'Extra manager' : a.lead ? `Team · TL ${a.lead.name}` : 'Team · no TL yet'}</div></div>
                  {c.isSuper && <button className="btn btn-ghost icon-btn" aria-label={`Unassign ${a.name}`} onClick={() => unassign(a)}><X size={16} /></button>}
                </div>
              ))}
            </div>
          </div>
          {c.canManage && (
            <div className="card">
              <div className="card-head"><div><h3>People with access</h3><p className="small muted">{c.isSuper ? 'Grant access to employees and team leads, or let work assignments grant it automatically.' : 'People get access automatically when their TL assigns them work here.'}</p></div>
                <button className="btn btn-tonal btn-sm" onClick={() => setGranting(true)}><UserPlus size={16} />Grant</button></div>
              {c.permissions.length === 0 ? <p className="small muted" style={{ padding: 20 }}>No direct access grants yet.</p> : (
                <div className="list">{c.permissions.map((p) => (
                  <div key={p._id} className="list-item" style={{ cursor: 'default' }}>
                    <Avatar name={p.user.name} size="sm" />
                    <div className="li-main"><div className="title">{p.user.name}</div>
                      <div className="li-meta">{p.expiresAt ? <span className="row" style={{ gap: 4, color: 'var(--warning)' }}><Clock size={12} />Until {fmtDate(p.expiresAt)}</span> : 'Permanent'}{p.grantedBy && <> · by {p.grantedBy.name}</>}</div></div>
                    <button className="btn btn-ghost icon-btn" aria-label={`Revoke ${p.user.name}`} onClick={() => revoke(p)}><Trash2 size={16} /></button>
                  </div>
                ))}</div>
              )}
              {c.requests.length > 0 && <>
                <div className="group-label" style={{ borderTop: '1px solid var(--border)' }}>Awaiting Super Admin</div>
                {c.requests.map((r) => <div key={r._id} className="list-item" style={{ cursor: 'default' }}><Avatar name={r.user.name} size="sm" /><div className="li-main"><div className="title">{r.user.name}</div><div className="li-meta">Requested by {r.requestedBy.name}</div></div><Badge cls="b-warning">Pending</Badge></div>)}
              </>}
            </div>
          )}
      </div>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <div><h3>Projects</h3><p className="small muted">Open a project to view its tasks, schedule and scope separately.</p></div>
          <Link className="btn btn-outline" to={`/clients/${id}/projects`}>View all projects →</Link>
        </div>
        {hasProjects && <div className="grid grid-2" style={{ marginTop: 14 }}>
          {projects.data.map(p => <Link key={p._id} className="card card-pad" to={`/clients/${id}/projects/${p._id}`} style={{ color: 'var(--text)', border: '1px solid var(--border)' }}>
            <strong>{p.name}</strong><p className="small muted" style={{ marginTop: 6 }}>{p.description || 'Open project tasks and details'}</p>
            <span className="small">Open project →</span>
          </Link>)}
        </div>}
      </div>
      {!hasProjects && <div style={{ marginBottom: 18 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h3>Work</h3><div className="spacer" />
          <div className="chips">{[['open','Open'],['done','Completed'],['all','All']].map(([k,l]) =>
            <button key={k} className={`chip ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{l}</button>
          )}</div>
        </div>
        <TaskListCard tasks={tasks.data} loading={tasks.loading} onOpen={t => setOpenId(t._id)} onToggle={can.hr ? undefined : toggle} emptyTitle="No tasks for this client" />
        <TaskPagination {...tasks} />
      </div>}
      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={tasks.reload} />}
      {editingClient && <ClientDetailsEditor client={c} onClose={() => setEditingClient(false)} onSaved={reload} />}
      {recurring && <TaskForm recurring presetClient={id} onClose={() => setRecurring(false)} onSaved={tasks.reload} />}
      {creating && <TaskForm presetClient={id} onClose={() => setCreating(false)} onSaved={tasks.reload} />}
      {granting && <GrantAccess client={c} onClose={() => setGranting(false)} onSaved={reload} />}
      {assigning && <AssignManager client={c} onClose={() => setAssigning(false)} onSaved={reload} />}
    </>
  );
}

function EmailRules({ client, onSaved }) {
  const toast = useToast();
  const [value, setValue] = useState((client.emailMatches || []).join(', '));
  const save = async () => {
    try {
      await api(`/clients/${client._id}`, { method: 'PATCH', body: { emailMatches: value.split(/[\s,;]+/).filter(Boolean) } });
      toast('Email rules saved'); onSaved();
    } catch (e) { toast(e.message); }
  };
  return (
    <Field label="Client’s email addresses" hint="Email from these addresses or domains is tagged to this client automatically. Example: hamilton.com, ceo@hamilton.com">
      <div className="row"><input className="input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Client email addresses" /><button className="btn btn-tonal btn-sm" onClick={save}>Save</button></div>
    </Field>
  );
}

function GrantAccess({ client, onClose, onSaved }) {
  const { can } = useAuth();
  const users = useApi('/users');
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [temporary, setTemporary] = useState(false);
  const [expiresAt, setExpiresAt] = useState(toInputDate(Date.now() + 14 * 864e5));
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const has = new Set(client.permissions.map((p) => p.user._id));
  const options = (users.data || []).filter((u) =>
    u.active && !has.has(u._id) && (u.role === 'employee' || (can.super && u.role === 'admin')));
  const submit = async (e) => {
    e.preventDefault();
    try {
      const res = await api(`/clients/${client._id}/permissions`, { method: 'POST', body: { userId, reason, expiresAt: temporary ? new Date(`${expiresAt}T23:59:59`).toISOString() : null } });
      toast(res.pending ? res.message : 'Access granted'); onSaved(); onClose();
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={`Grant access to ${client.name}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="grant-form" disabled={!userId}>Grant access</button></>}>
      <form id="grant-form" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label={can.super ? "Employee or team lead" : "Employee"}>
          <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Select…</option>
            {options.map((u) => {
              const teams = u.teams?.map((membership) => membership.team?.name).filter(Boolean).join(', ');
              return <option key={u._id} value={u._id}>{[u.name, can.super && ROLE_LABEL[u.role], teams].filter(Boolean).join(' · ')}</option>;
            })}
          </select>
        </Field>
        <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} />Temporary access</label>
        {temporary && <Field label="Access ends on"><input type="date" className="input" value={expiresAt} min={toInputDate(new Date())} onChange={(e) => setExpiresAt(e.target.value)} /></Field>}
        {!can.super && <>
          <div className="form-note">If this person isn’t in a team you lead, the request goes to a Super Admin for approval.</div>
          <Field label="Reason (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Covering during month-end" /></Field>
        </>}
      </form>
    </Modal>
  );
}

function AssignManager({ client, onClose, onSaved }) {
  const teams = useApi('/teams');
  const users = useApi('/users');
  const [error, setError] = useState(null);
  const assign = async (body) => { try { await api(`/clients/${client._id}/assignments`, { method: 'POST', body }); onSaved(); onClose(); } catch (e) { setError(e); } };
  const hasTeam = new Set(client.teams.map((t) => t._id));
  const hasAdmin = new Set(client.admins.map((a) => a._id));
  return (
    <Modal title={`Who manages ${client.name}?`} onClose={onClose}>
      <ErrorBox error={error} />
      <Field label="Add a team"><div className="chips">{(teams.data || []).filter((t) => !hasTeam.has(t._id)).map((t) => (
        <button key={t._id} className="chip" onClick={() => assign({ teamId: t._id })}><span className="team-dot" style={{ background: t.color }} />{t.name}</button>
      ))}</div></Field>
      <Field label="Add an extra manager" hint="The team’s TL already manages the client. Add someone here only if another Admin / TL should too."><div className="chips">{(users.data || []).filter((u) => ['super_admin', 'manager', 'admin'].includes(u.role) && !hasAdmin.has(u._id)).map((u) => (
        <button key={u._id} className="chip" style={{ paddingLeft: 4 }} onClick={() => assign({ adminId: u._id })}><Avatar name={u.name} size="sm" />{u.name}<span className="muted small">{ROLE_LABEL[u.role]}</span></button>
      ))}</div></Field>
    </Modal>
  );
}

function ClientDetailsEditor({ client, onClose, onSaved }) {
  const [form, setForm] = useState(() => Object.fromEntries(['name', 'accountingId', 'contactName', 'contactEmail', 'contactPhone', 'notes'].map(k => [k, client[k] || ''])));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fields = { name: 'Client / company name', accountingId: 'Accounting ID', contactName: 'Contact name', contactEmail: 'Contact email', contactPhone: 'Contact phone', notes: 'Notes' };
  return <Modal title="Edit client / company" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button form="edit-client" className="btn btn-primary" disabled={busy || !form.name.trim()}>Save changes</button></>}>
    <form id="edit-client" className="stack" style={{ gap: 12 }} onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(null);
      try { await api(`/clients/${client._id}`, { method: 'PATCH', body: form }); onSaved(); onClose(); }
      catch (e) { setError(e); } finally { setBusy(false); }
    }}><ErrorBox error={error}/>{Object.entries(fields).map(([key,label]) => <Field key={key} label={label}><input className="input" required={key === 'name'} maxLength={key === 'name' ? 120 : undefined} value={form[key]} onChange={e => setForm(s => ({ ...s, [key]: e.target.value }))}/></Field>)}</form>
  </Modal>;
}

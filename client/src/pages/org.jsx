import { ProjectAssignment } from '../project-assignment.jsx';
import GoogleSignIn from '../GoogleSignIn.jsx';
import { useEffect, useId, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus, UserPlus, X, Repeat, Pause, Play, ShieldCheck, Search, Check, History, Crown, Users, Building2, Lock, CalendarCheck, Trash2, Pencil } from 'lucide-react';
import { api, useApi, useAuth, useToast, fmtDate, fmtTime, ROLE_LABEL } from '../lib.jsx';
import { Avatar, Avatars, Badge, BrandName, Empty, ErrorBox, Field, Modal, PageHead, Skeleton, TeamTag } from '../ui.jsx';
import { TaskForm } from '../tasks.jsx';

/* ---------- Teams ---------- */

export function Teams() {
  const { can, user } = useAuth();
  const { data, loading, reload } = useApi('/teams');
  const users = useApi('/users');
  const toast = useToast();
  const [adding, setAdding] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const removeTeam = async (team) => {
    if (!confirm(`Delete ${team.name}? Members leave the team; clients, tasks and history are kept.`)) return;
    try { await api(`/teams/${team._id}`, { method: 'DELETE' }); toast(`${team.name} deleted`); reload(); } catch (e) { toast(e.message); }
  };
  const remove = async (team, m) => {
    if (!confirm(`Remove ${m.name} from ${team.name}? Their other teams and client access are not affected.`)) return;
    try { await api(`/teams/${team._id}/members/${m._id}`, { method: 'DELETE' }); toast(`${m.name} removed from ${team.name}`); reload(); } catch (e) { toast(e.message); }
  };
  const visible = can.super ? data : data?.filter((t) => t.canManage || t.members.some((m) => m._id === user._id));

  return (
    <>
      <PageHead title="Teams" subtitle="Each team is run by one TL / manager. The TL manages the team’s clients and assigns its work.">
        {can.super && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} />New team</button>}
      </PageHead>
      {loading && !data ? <div className="card"><Skeleton /></div> : (
        <div className="grid grid-3">
          {visible.map((t) => (
            <div key={t._id} className="card" style={{ overflow: 'hidden' }}>
              <div style={{ height: 6, background: t.color }} />
              <div className="card-head">
                <div><h3>{t.name}</h3><p className="small muted">{t.description}</p></div>
                <div className="row" style={{ gap: 4 }}>
                  {t.canManage && <button className="btn btn-tonal icon-btn" aria-label={`Add member to ${t.name}`} title="Add member" onClick={() => setAdding(t)}><UserPlus size={18} /></button>}
                  {can.super && <button className="btn btn-ghost icon-btn" aria-label={`Edit ${t.name}`} title="Edit team / change TL" onClick={() => setEditing(t)}><Pencil size={16} /></button>}
                  {can.super && <button className="btn btn-ghost icon-btn" aria-label={`Delete ${t.name}`} title="Delete team" onClick={() => removeTeam(t)}><Trash2 size={16} /></button>}
                </div>
              </div>
              {!t.members.some((m) => m.teamRole === 'lead') && <div className="form-note" style={{ margin: 12, background: 'var(--warning-soft)', color: 'var(--warning)' }}>No TL yet. {can.super ? 'Click the pencil to choose one.' : 'Ask a Super Admin to choose one.'}</div>}
              <div className="list">
                {[...t.members].sort((a, b) => (a.teamRole === 'lead' ? -1 : b.teamRole === 'lead' ? 1 : 0)).map((m) => (
                  <div key={m._id} className="list-item" style={{ cursor: 'default' }}>
                    <Avatar name={m.name} size="sm" />
                    <div className="li-main"><div className="title">{m.name}</div><div className="li-meta">{m.title}</div></div>
                    {m.teamRole === 'lead' && <Badge cls="b-warning"><Crown size={12} />TL</Badge>}
                    {t.canManage && m.teamRole !== 'lead' && <button className="btn btn-ghost icon-btn" aria-label={`Remove ${m.name}`} onClick={() => remove(t, m)}><X size={16} /></button>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <AddMember team={adding} users={users.data || []} onClose={() => setAdding(null)} onSaved={reload} />}
      {creating && <TeamForm users={users.data || []} onClose={() => setCreating(false)} onSaved={reload} />}
      {editing && <TeamForm team={editing} users={users.data || []} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function AddMember({ team, users, onClose, onSaved }) {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState(null);
  const ids = new Set(team.members.map((m) => m._id));
  const submit = async (e) => { e.preventDefault(); try { await api(`/teams/${team._id}/members`, { method: 'POST', body: { userId } }); onSaved(); onClose(); } catch (err) { setError(err); } };
  return (
    <Modal title={`Add to ${team.name}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="am" disabled={!userId}>Add</button></>}>
      <form id="am" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Person"><select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Select…</option>
          {users.filter((u) => !ids.has(u._id) && u.active && u.role === 'employee').map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}</select></Field>
        <div className="form-note">Members get access to a client automatically when their TL assigns them work for it.</div>
      </form>
    </Modal>
  );
}

function TeamForm({ team, users, onClose, onSaved }) {
  const currentLead = team?.members.find((m) => m.teamRole === 'lead');
  const [f, setF] = useState({ name: team?.name || '', description: team?.description || '', color: team?.color || '#2f9e44', leadId: currentLead?._id || '' });
  const [error, setError] = useState(null);
  const admins = users.filter((u) => u.role === 'admin' && u.active);
  const submit = async (e) => {
    e.preventDefault();
    try { await api(team ? `/teams/${team._id}` : '/teams', { method: team ? 'PATCH' : 'POST', body: f }); onSaved(); onClose(); } catch (err) { setError(err); }
  };
  return (
    <Modal title={team ? `Edit ${team.name}` : 'New team'} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="nt" disabled={!f.name || !f.leadId}>{team ? 'Save' : 'Create team'}</button></>}>
      <form id="nt" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Team name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="TL / Manager" hint={admins.length ? 'One TL runs each team and manages all of its clients.' : 'First add a person with the Admin / TL role on the People page.'}>
          <select className="select" value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })} required>
            <option value="">Choose a TL…</option>
            {admins.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Bookkeeping & bills" /></Field>
        <Field label="Colour"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ width: 64, height: 40, border: 0, background: 'none' }} /></Field>
      </form>
    </Modal>
  );
}

/* ---------- People ---------- */

export function People() {
  const { user: me, can } = useAuth();
  const { data, error, loading, reload } = useApi('/users?dailyReport=1');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const filtered = (data || []).filter(({ name, email }) => `${name} ${email}`.toLowerCase().includes(query));
  const [creating, setCreating] = useState(false);
  const [assigningPerson, setAssigningPerson] = useState(null);
  const [editingPerson, setEditingPerson] = useState(null);
  const [changingLeave, setChangingLeave] = useState(null);
  async function changeLeave(person) {
    const onLeave = !person.onLeave;
    setChangingLeave(person._id);
    try {
      await api(`/users/${person._id}/leave`, { method: 'PUT', body: { onLeave } });
      toast(onLeave ? `${person.name} is on leave.` : `${person.name} is back at work.`);
      reload();
    } catch (error) {
      toast(error.message);
    } finally {
      setChangingLeave(null);
    }
  }
  const update = async (u, body) => { try { await api(`/users/${u._id}`, { method: 'PATCH', body }); toast('Saved'); reload(); } catch (e) { toast(e.message); } };
  const remove = async (u) => {
    if (!confirm(`Remove ${u.name}? They can no longer sign in and lose all team and client access. Their name stays on past tasks.`)) return;
    try { await api(`/users/${u._id}`, { method: 'DELETE' }); toast(`${u.name} removed`); reload(); } catch (e) { toast(e.message); }
  };
  return (
    <>
      <PageHead title="People" subtitle={data ? `Total people: ${data.length}` : undefined}>
        {can.super && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={18} />Add person</button>}
      </PageHead>
      <div className="people-search" role="search" aria-label="People">
        <div className="search">
          <Search size={18} aria-hidden="true" />
          <input className="input" type="search" aria-label="Search people" placeholder="Search people by name or email"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {data && query && <span className="small muted" role="status">{filtered.length} of {data.length} people</span>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <ErrorBox error={error} />
        {loading && !data ? <Skeleton /> : data && (!filtered.length
          ? <Empty icon={Users} title={query ? 'No people match your search' : 'No people yet'} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Role</th><th>Teams</th>{can.super && <th>Projects</th>}<th>Availability</th><th>Account</th>{can.super && <th />}</tr></thead>
            <tbody>{filtered.map((u) => (
              <tr key={u._id} style={!u.active ? { opacity: .55 } : undefined}>
                <td><div className="row" style={{ gap: 12 }}><Avatar name={u.name} /><div><strong>{u.name}</strong><div className="small muted">{u.email}</div>
                  {u.dailyReport?.enabled && <div className="small muted">Shift starts {u.dailyReport.shiftStart} IST</div>}
                </div></div></td>
                <td>{can.super ? <select className="select" style={{ minHeight: 36, width: 'auto' }} value={u.role} disabled={u._id === me._id} onChange={(e) => update(u, { role: e.target.value })} aria-label={`Role for ${u.name}`}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : ROLE_LABEL[u.role]}</td>
                <td><div className="row-wrap">{u.teams.map((t) => <span key={t.team._id} className="badge"><span className="team-dot" style={{ background: t.team.color }} />{t.team.name}{t.teamRole === 'lead' && <><Crown size={12} />TL</>}</span>)}</div></td>
                {can.super && <td>{u.active && (['super_admin', 'hr'].includes(u.role) ? <span className="small muted">All projects</span> :
                  <button type="button" className="btn btn-outline btn-sm" aria-label={`Assign projects to ${u.name}`}
                    onClick={() => setAssigningPerson(u)}><Plus size={14} />Assign projects</button>)}</td>}
                <td>{u.active && <div className="row-wrap">
                  <Badge cls={u.onLeave ? 'b-warning' : 'b-success'}>{u.onLeave ? 'On leave' : 'Active'}</Badge>
                  {can.super && <button type="button" className="btn btn-outline btn-sm" disabled={changingLeave !== null}
                    aria-label={`${u.onLeave ? 'Mark active' : 'Mark on leave'} for ${u.name}`}
                    onClick={() => changeLeave(u)}>{u.onLeave ? 'Mark active' : 'Mark on leave'}</button>}
                </div>}</td>
                <td>{!can.super ? <Badge>{u.active ? 'Enabled' : 'Deactivated'}</Badge> : u._id === me._id ? <Badge cls="b-primary">You</Badge> : (
                  <button className={`btn btn-sm ${u.active ? 'btn-outline' : 'btn-tonal'}`} onClick={() => update(u, { active: !u.active })}>{u.active ? 'Deactivate' : 'Reactivate'}</button>
                )}</td>
                {can.super && <td style={{ textAlign: 'right' }}><div className="row-wrap" style={{ justifyContent: 'flex-end' }}><button className="btn btn-outline btn-sm" onClick={() => setEditingPerson(u)}><Pencil size={14} />Edit</button>{u._id !== me._id && <button className="btn btn-danger btn-sm" onClick={() => remove(u)}><Trash2 size={14} />Remove</button>}</div></td>}
              </tr>
            ))}</tbody>
          </table></div>
        ))}
      </div>
      {assigningPerson && <ProjectAssignment person={assigningPerson} onClose={() => setAssigningPerson(null)} />}
      {creating && <NewPerson onClose={() => setCreating(false)} onSaved={reload} />}
      {editingPerson && <EditPerson person={editingPerson} isSelf={editingPerson._id === me._id} onClose={() => setEditingPerson(null)} onSaved={() => { reload(); setEditingPerson(null); }} />}
    </>
  );
}

function SlackUserIdField({ value, onChange }) {
  const id = useId();
  return <div className="field">
    <label htmlFor={id}>Slack user ID (optional)</label>
    <input id={id} className="input" value={value} onChange={onChange} maxLength={64} placeholder="U012ABC3456" aria-describedby={`${id}-hint`} />
    <span className="hint" id={`${id}-hint`}>In Slack, open the person’s profile and choose Copy member ID.</span>
  </div>;
}

const defaultDailyReport = { enabled: false, shiftStart: '09:00', reminderAt: '10:00' };

function DailyReportFields({ value, onChange }) {
  const set = (key, val) => onChange({ ...value, [key]: val });
  return <div className="stack" style={{ gap: 8 }}>
    <label className="row"><input type="checkbox" checked={value.enabled} onChange={(event) => set('enabled', event.target.checked)} />Include in scheduled Daily Work Slack reports</label>
    <div className="grid grid-2">
      <label className="field"><span>Shift starts (IST)</span>
        <input className="input" type="time" required value={value.shiftStart} onChange={(event) => {
          const shiftStart = event.target.value;
          const reportTime = shiftStart < '12:00' ? '10:00' : '15:30';
          onChange({ ...value, shiftStart, reminderAt: shiftStart > reportTime ? shiftStart : reportTime });
        }} />
      </label>
    </div>
    <span className="hint">Weekday reports check morning shifts at 10:00 AM and afternoon shifts at 3:30 PM IST.</span>
  </div>;
}

function EditPerson({ person, isSelf, onClose, onSaved }) {
  const [form, setForm] = useState({ name: person.name || '', email: person.email || '', title: person.title || '', role: person.role, slackUserId: person.slackUserId || '', dailyReport: person.dailyReport || defaultDailyReport });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const set = (field) => (event) => setForm(v => ({ ...v, [field]: event.target.value }));
  const save = async event => {
    event.preventDefault(); setError(null); setSaving(true);
    try {
      await api(`/users/${person._id}`, { method: 'PATCH', body: form });
      toast('Person updated'); onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return <Modal title={`Edit person · ${person.name}`} onClose={onClose} footer={<>
    <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
    <button type="submit" form="edit-person" className="btn btn-primary" disabled={saving || !form.name.trim() || !form.email.trim()}>{saving ? 'Saving…' : 'Save changes'}</button>
  </>}>
    <form id="edit-person" className="stack" onSubmit={save} style={{ gap: 16 }}>
      <ErrorBox error={error} />
      <Field label="Full name"><input className="input" value={form.name} onChange={set('name')} required maxLength={150} autoFocus /></Field>
      <Field label="Job title"><input className="input" value={form.title} onChange={set('title')} maxLength={150} /></Field>
      <Field label="Sign-in email"><input className="input" type="email" value={form.email} onChange={set('email')} required maxLength={254} /></Field>
      <SlackUserIdField value={form.slackUserId} onChange={set('slackUserId')} />
      <DailyReportFields value={form.dailyReport} onChange={(dailyReport) => setForm((previous) => ({ ...previous, dailyReport }))} />
      <Field label="Role" hint={isSelf ? 'You cannot change your own Super Admin role.' : 'Changing roles updates this person’s permissions.'}>
        <select className="select" value={form.role} onChange={set('role')} disabled={isSelf}>
          {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <p className="small muted">Account details are updated without deleting the employee’s assigned tasks, history or access records.</p>
    </form>
  </Modal>;
}

function NewPerson({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', role: 'employee', title: '', slackUserId: '', dailyReport: defaultDailyReport });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => { e.preventDefault(); try { await api('/users', { method: 'POST', body: f }); onSaved(); onClose(); } catch (err) { setError(err); } };
  return (
    <Modal title="Add person" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="np">Create account</button></>}>
      <form id="np" className="stack" style={{ gap: 16 }} onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid grid-2">
          <Field label="Full name"><input className="input" value={f.name} onChange={set('name')} required autoFocus /></Field>
          <Field label="Job title"><input className="input" value={f.title} onChange={set('title')} /></Field>
        </div>
        <Field label="Sign-in email" hint="Use the personal email address this person will verify."><input className="input" type="email" value={f.email} onChange={set('email')} required /></Field>
        <SlackUserIdField value={f.slackUserId} onChange={set('slackUserId')} />
        <DailyReportFields value={f.dailyReport} onChange={(dailyReport) => setF((previous) => ({ ...previous, dailyReport }))} />
        <Field label="Role"><select className="select" value={f.role} onChange={set('role')}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </form>
    </Modal>
  );
}

/* ---------- Recurring work ---------- */

const FREQ = (t) => t.frequency === 'daily' ? 'Every working day'
  : t.frequency === 'weekly' ? `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][t.weekday ?? 1]}`
  : t.frequency === 'semimonthly' ? `Twice monthly on ${(t.monthDays || []).join(' and ')}` : `Monthly on day ${t.monthDay}`;

export function Recurring() {
  const { can } = useAuth();
  const { data, loading, reload } = useApi('/templates');
  const clients = useApi('/clients');
  const toast = useToast();
  const [selectedClient, setSelectedClient] = useState(null);
  const [creating, setCreating] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [search, setSearch] = useState('');
  const clientsById = new Map((clients.data || []).filter((client) => client.canManage).map((client) => [client._id, client]));
  for (const { client } of data || []) {
    if (client && !clientsById.has(client._id)) clientsById.set(client._id, client);
  }
  const availableClients = [...clientsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const shownClients = availableClients.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
  const selected = availableClients.find((c) => c._id === selectedClient);
  const templates = (data || []).filter((t) => t.client?._id === selectedClient);
  const removeTemplate = async (t) => {
    if (!window.confirm(`Cancel the recurring schedule “${t.title}”? Unstarted future occurrences will be removed. Completed, in-progress and historical tasks will be kept.`)) return;
    try { await api(`/templates/${t._id}`, { method: 'DELETE' }); toast('Recurring schedule cancelled; future unstarted tasks removed'); reload(); }
    catch (e) { toast(e.message); }
  };
  const toggle = async (t) => {
    try {
      await api(`/templates/${t._id}`, { method: 'PATCH', body: { active: !t.active } });
      toast(t.active ? 'Paused' : 'Resumed'); reload();
    } catch (e) { toast(e.message); }
  };
  return (
    <>
      <PageHead title="Recurring work" subtitle="Choose a client to schedule and manage their recurring tasks." />
      {!selected ? (
        <>
          <div className="row-wrap" style={{ marginBottom: 18 }}>
            <input className="input" style={{ maxWidth: 360 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" aria-label="Search clients" />
            <span className="small muted">{shownClients.length} clients</span>
          </div>
          {clients.loading && !clients.data ? <div className="card"><Skeleton /></div> :
            shownClients.length === 0 ? <div className="card"><Empty icon={Building2} title="No clients found" /></div> :
            <div className="grid grid-3">
              {shownClients.map((c) => {
                const count = (data || []).filter((t) => t.client?._id === c._id).length;
                return <button key={c._id} className="card card-pad" style={{ textAlign: 'left', cursor: 'pointer', minHeight: 105 }} onClick={() => setSelectedClient(c._id)}>
                  <div className="row"><Building2 size={20} className="muted" /><strong>{c.name}</strong></div>
                  <div className="small muted" style={{ marginTop: 12 }}>{count} recurring task{count === 1 ? '' : 's'} · Open client work →</div>
                </button>;
              })}
            </div>
          }
        </>
      ) : (
        <>
          <div className="row-wrap" style={{ marginBottom: 20 }}>
            <button className="btn btn-ghost" onClick={() => setSelectedClient(null)}>← All clients</button>
            <h2>{selected.name}</h2><div className="spacer" />
            {selected.canManage && !can.super && <><button className="btn btn-primary" onClick={() => setCreating('recurring')}><Plus size={18} />Add recurring task</button>
            <button className="btn btn-outline" onClick={() => setCreating('once')}><Plus size={18} />Add one-time task</button></>}
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {loading && !data ? <Skeleton /> : templates.length === 0 ? <Empty icon={Repeat} title="No recurring tasks for this client yet" /> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Task</th><th>Schedule</th><th>Assigned</th><th>Status</th><th /></tr></thead>
                <tbody>{templates.map((t) => (
                  <tr key={t._id} style={!t.active ? { opacity: .55 } : undefined}>
                    <td><strong>{t.title}</strong>{t.project && <div className="small muted">{t.project.name}</div>}<div className="small muted">{t.checklist.length} checklist steps{t.sop ? ' · SOP attached' : ''}</div></td>
                    <td><span className="row"><CalendarCheck size={16} className="muted" />{FREQ(t)}</span></td>
                    <td><Avatars people={t.assignees} /></td>
                    <td>{t.active ? 'Active' : 'Paused'}</td>
                    <td style={{ textAlign: 'right' }}><div className="row-wrap" style={{ justifyContent: 'flex-end' }}>{t.canEdit && <>
                      <button className="btn btn-outline btn-sm" onClick={() => setEditingTemplate(t)}>Edit future occurrences</button>
                      {t.canDelete && can.editTasks && <button className="btn btn-outline btn-sm" onClick={() => removeTemplate(t)}>Cancel future occurrences</button>}
                      <button className="btn btn-outline btn-sm" onClick={() => toggle(t)}>{t.active ? <><Pause size={14} />Pause</> : <><Play size={14} />Resume</>}</button>
                    </>}</div></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </>
      )}
      {editingTemplate && <TaskForm key={editingTemplate._id} recurring template={editingTemplate} presetClient={selectedClient} onClose={() => setEditingTemplate(null)} onSaved={() => { reload(); setEditingTemplate(null); }} />}
      {creating && <TaskForm key={selectedClient + creating} recurring={creating === 'recurring'} presetClient={selectedClient} onClose={() => setCreating(null)} onSaved={() => { reload(); setCreating(null); }} />}
    </>
  );
}

/* ---------- Access requests ---------- */

function SignInRequests() {
  const { data, error, loading, reload } = useOutletContext();
  const [review, setReview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const toast = useToast();

  function open(request) {
    setReviewError(null);
    setReview({ request, name: request.name, title: '', slackUserId: '' });
  }

  async function decide(decision) {
    setSaving(true);
    setReviewError(null);
    const { request, name, title, slackUserId } = review;
    try {
      await api(`/sign-in-requests/${encodeURIComponent(request._id)}/${decision}`, {
        method: 'POST', body: decision === 'approve' ? { name, title, slackUserId } : undefined,
      });
      setReview(null);
      reload();
      toast(decision === 'approve' ? 'Sign-in approved' : 'Sign-in request rejected');
    } catch (error) {
      setReviewError(error);
    } finally {
      setSaving(false);
    }
  }

  const fields = (key) => ({
    value: review[key], maxLength: key === 'slackUserId' ? 64 : 150,
    onChange: (event) => setReview({ ...review, [key]: event.target.value }),
  });
  const row = (request) => <div key={request._id} className="list-item">
    <Avatar name={request.name} />
    <div className="li-main"><div className="title">{request.name}</div>
      <div className="li-meta">{request._id} · {fmtTime(request.createdAt)}</div></div>
    {request.status === 'pending' ? <button className="btn btn-outline btn-sm" onClick={() => open(request)}>Review</button>
      : <Badge cls={request.status === 'approved' ? 'b-success' : 'b-danger'}>{request.status}</Badge>}
  </div>;

  return <>
    <section className="card" aria-labelledby="sign-in-requests">
      <div className="card-head"><h3 id="sign-in-requests">Company sign-in requests</h3>
        <div className="row">
          <Badge cls={data?.pending.length ? 'b-warning' : ''}>{data?.pending.length || 0} pending</Badge>
          <button className="btn btn-outline btn-sm" onClick={reload}>Refresh</button>
        </div>
      </div>
      {error ? <ErrorBox error={error} /> : loading ? <Skeleton rows={2} />
        : data?.pending.length ? <div className="list">{data.pending.map(row)}</div>
          : <Empty icon={UserPlus} title="No pending sign-in requests" />}
      {!!data?.history.length && <details>
        <summary className="card-pad">Sign-in request history</summary>
        <div className="list">{data.history.map(row)}</div>
      </details>}
    </section>
    {review && <Modal title="Review sign-in request" onClose={() => { if (!saving) setReview(null); }} footer={
      <>
        <button type="button" className="btn btn-outline" disabled={saving} onClick={() => decide('reject')}>Reject</button>
        <button type="submit" form="sign-in-review" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Approve sign-in'}
        </button>
      </>}>
      <form id="sign-in-review" className="stack" onSubmit={(event) => { event.preventDefault(); decide('approve'); }}>
        <p><strong>{review.request._id}</strong></p>
        <p className="small muted">Approving creates an Employee account. You can assign teams and client access separately.</p>
        <label className="field">Name (optional)<input className="input" {...fields('name')} /></label>
        <label className="field">Job title (optional)<input className="input" {...fields('title')} /></label>
        <label className="field">Slack user ID (optional)<input className="input" placeholder="U012ABC3456" {...fields('slackUserId')} /></label>
        <ErrorBox error={reviewError} />
      </form>
    </Modal>}
  </>;
}

export function Access() {
  const { can } = useAuth();
  const { data, loading, reload } = useApi('/access-requests');
  const toast = useToast();
  const decide = async (r, d) => { try { await api(`/access-requests/${r._id}/${d}`, { method: 'POST' }); toast(d === 'approve' ? 'Access approved' : 'Request rejected'); reload(); } catch (e) { toast(e.message); } };
  const pending = (data || []).filter((r) => r.status === 'pending');
  const past = (data || []).filter((r) => r.status !== 'pending');
  const row = (r) => (
    <div key={r._id} className="list-item" style={{ cursor: 'default' }}>
      <Avatar name={r.user.name} />
      <div className="li-main">
        <div className="title">{r.user.name} → {r.client.name}</div>
        <div className="li-meta">Requested by {r.requestedBy.name} · {fmtTime(r.createdAt)}{r.expiresAt && <> · until {fmtDate(r.expiresAt)}</>}{r.reason && <> · “{r.reason}”</>}</div>
      </div>
      {r.status === 'pending' && can.super ? <>
        <button className="btn btn-outline btn-sm" onClick={() => decide(r, 'reject')}><X size={14} />Reject</button>
        <button className="btn btn-primary btn-sm" onClick={() => decide(r, 'approve')}><Check size={14} />Approve</button>
      </> : <Badge cls={r.status === 'approved' ? 'b-success' : r.status === 'rejected' ? 'b-danger' : 'b-warning'}>{r.status}</Badge>}
    </div>
  );
  return (
    <>
      <PageHead title="Access requests" subtitle={can.super ? 'Review company sign-in and client access requests.' : 'Requests you have sent to a Super Admin.'} />
      <div className="stack" style={{ gap: 24 }}>
        {can.super && <SignInRequests />}
        <div className="card">
          <div className="card-head"><h3>Pending client access</h3><Badge cls={pending.length ? 'b-warning' : ''}>{pending.length}</Badge></div>
          {loading && !data ? <Skeleton rows={2} /> : pending.length ? <div className="list">{pending.map(row)}</div> : <Empty icon={ShieldCheck} title="No pending requests" />}
        </div>
        {past.length > 0 && <div className="card"><div className="card-head"><h3>History</h3></div><div className="list">{past.map(row)}</div></div>}
      </div>
    </>
  );
}

/* ---------- Activity log ---------- */

const addedTaskActions = new Set(['task.create', 'project.work.create', 'template.create']);

export function Audit() {
  const { data, error, loading } = useApi('/audit');
  return (
    <>
      <PageHead title="Activity log" subtitle="Tasks added or edited in the last 7 days." />
      <div className="card" style={{ overflow: 'hidden' }}>
        {error ? <ErrorBox error={error} /> : loading && !data ? <Skeleton /> : !data?.length ? <Empty icon={History} title="No activity yet" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th>Client</th></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a._id}>
                <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(a.createdAt)}</td>
                <td><span className="row"><Avatar name={a.actor?.name || 'System'} size="sm" />{a.actor?.name || 'System'}</span></td>
                <td><Badge>{addedTaskActions.has(a.action) ? 'Task added' : 'Task edited'}</Badge> <span style={{ marginLeft: 6 }}>{a.summary}</span></td>
                <td>{a.project?.name || '—'}</td><td>{a.client?.name || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

/* ---------- Login ---------- */

const DEMO = [
  ['owner@demo.test', 'Priya Sharma', 'Super Admin'],
  ['anita@demo.test', 'Anita Rao', 'Admin · Team A'],
  ['rahul@demo.test', 'Rahul Mehta', 'Admin · Team B'],
  ['neha@demo.test', 'Employee 2 · Neha', 'Teams A + B'],
  ['pooja@demo.test', 'Employee 4 · Pooja', 'Teams A + B + C'],
  ['amit@demo.test', 'Employee 1 · Amit', 'Team A'],
];

export function Login() {
  const { signIn, offline } = useAuth();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(null);
  const [requestStatus, setRequestStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const config = useApi('/config');
  const googleClientId = config.data?.googleSignInClientId;
  const emailEnabled = config.data?.emailLoginConfigured;
  useEffect(() => {
    if (!resendAt) return;
    const timer = setTimeout(() => setResendAt(null), Math.max(0, resendAt - Date.now()));
    return () => clearTimeout(timer);
  }, [resendAt]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (error) { setError(error); } finally { setBusy(false); }
  }

  function sendCode() {
    return run(async () => {
      const result = await api('/auth/email/request', { method: 'POST', body: { email } });
      setChallenge(result.challenge);
      setCode('');
      setResendAt(Date.now() + 60000);
    });
  }
  return (
    <div className="login">
      <section className="login-hero">
        <BrandName />
        <div>
          <h1>Every client, task and team — one calm workspace.</h1>
          <p>Built for accounting practices where people work across several teams, and every client’s data stays private.</p>
        </div>
        <div className="hero-points">
          <div><Users size={20} />One login across all your teams</div>
          <div><Lock size={20} />Each team is run by its own TL / manager</div>
          <div><Repeat size={20} />Recurring work with SOPs and checklists</div>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <div className="login-mobile-brand"><BrandName /></div>
          {requestStatus ? <>
            <div role="status">
              <h1>{requestStatus === 'pending' ? 'Request sent' : 'Sign-in request reviewed'}</h1>
              <p className="muted">{requestStatus === 'pending'
                ? 'A Super Admin needs to approve your company account. Sign in again after approval.'
                : 'Contact your Super Admin to check access for your company account.'}</p>
            </div>
            <button type="button" className="btn btn-outline" onClick={() => {
              setRequestStatus(null); setChallenge(''); setCode(''); setError(null);
            }}>Back to sign in</button>
          </> : <>
          <div><h1>{challenge ? 'Check your email' : 'Sign in'}</h1><p className="muted" style={{ marginTop: 4 }}>
            {challenge ? `If ${email} is eligible, a six-digit code will arrive shortly.` :
              googleClientId ? 'Use your GATP company email or your registered Google account.' : 'Use your GATP company email or your registered email address.'}
          </p></div>
          <ErrorBox error={error || config.error || (offline ? new Error('Couldn’t reconnect to Workflow. Reload to try again.') : null)} />
          {googleClientId && !challenge && <GoogleSignIn clientId={googleClientId} onRequest={setRequestStatus} />}
          {config.data && !googleClientId && !emailEnabled && !config.data.demo &&
            <p className="small muted">Sign-in setup is required. Contact your Workflow administrator.</p>}
          {emailEnabled && <form className="stack" style={{ gap: 16 }} onSubmit={(event) => {
            event.preventDefault();
            if (challenge) run(async () => {
              const status = await signIn('/auth/email/verify', { email, challenge, code });
              if (status) setRequestStatus(status);
            });
            else sendCode();
          }}>
            {challenge ? <label className="field">Verification code<input className="input" key="code" autoFocus
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} required /></label>
              : <label className="field">Email address<input className="input" key="email" autoFocus type="email" autoComplete="email" value={email}
                onChange={(event) => setEmail(event.target.value)} required /></label>}
            <button className="btn btn-primary" disabled={busy} style={{ minHeight: 48 }}>
              {challenge ? busy ? 'Verifying…' : 'Verify and sign in' : busy ? 'Sending…' : 'Send code'}
            </button>
            {challenge && <div className="row-wrap">
              <button type="button" className="btn btn-ghost" disabled={busy || !!resendAt} onClick={sendCode}>Resend code</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setChallenge(''); setCode(''); setError(null); }}>Change email</button>
            </div>}
          </form>}
          {config.data?.demo && <div>
            <div className="row" style={{ margin: '4px 0 10px' }}><Building2 size={14} className="muted" /><span className="small muted">Demo accounts — try each role</span></div>
            <div className="demo-grid">
              {DEMO.map(([em, name, role]) => (
                <button key={em} className="demo-btn" disabled={busy} onClick={() => run(() => signIn('/auth/demo', { email: em }))}>
                  <Avatar name={name} size="sm" /><span><strong style={{ display: 'block' }}>{name.replace(/Employee \d+ · /, '')}</strong><span className="muted small">{role}</span></span>
                </button>
              ))}
            </div>
          </div>}
          </>}
        </div>
      </section>
    </div>
  );
}

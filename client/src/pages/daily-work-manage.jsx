import { useState } from 'react';
import { api, useApi, useAuth, useToast } from '../lib.jsx';
import { Badge, Empty, ErrorBox, Skeleton } from '../ui.jsx';

const root = '/daily-work';
const input = (value) => value ?? '';
const editingItem = { title: '', description: '', hours: '' };

function Form({ children, submit, label = 'Save', cancel }) {
  const [busy, setBusy] = useState(false);
  return <form className="stack" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    try { await submit(); }
    finally { setBusy(false); }
  }}>
    {children}
    <div className="row-wrap">
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : label}</button>
      {cancel && <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>}
    </div>
  </form>;
}

function TextField({ label, value, set, ...props }) {
  return <label className="field"><span>{label}</span><input className="input" value={input(value)}
    onChange={(event) => set(event.target.value)} {...props} /></label>;
}

function Select({ label, value, set, children, ...props }) {
  return <label className="field"><span>{label}</span><select className="select" value={input(value)}
    onChange={(event) => set(event.target.value)} {...props}>{children}</select></label>;
}

function useForm(initial) {
  const [state, setState] = useState(initial);
  return [state, (field) => (value) => setState((old) => ({ ...old, [field]: value })), setState];
}

function ProjectSetup({ data, save, active, select }) {
  const [draft, field, reset] = useForm({ clientId: '', workflowProjectId: '', name: '' });
  const [renaming, setRenaming] = useState(null);
  return <section className="card daily-card stack">
    <h2>Projects</h2>
    <Form label="Add project" submit={async () => {
      const added = await save('/projects', 'POST', draft, 'Project added.');
      if (added) { select(added._id); reset({ clientId: '', workflowProjectId: '', name: '' }); }
    }}>
      <div className="row-wrap daily-controls">
        <Select label="Workflow client" value={draft.clientId} set={(clientId) => reset({ clientId, workflowProjectId: '', name: '' })} required>
          <option value="">Select client</option>
          {data.clients.map((item) => <option value={item._id} key={item._id}>{item.name}</option>)}
        </Select>
        <Select label="Link Workflow project" value={draft.workflowProjectId} set={(workflowProjectId) => reset({
          ...draft, workflowProjectId, name: data.projects.find((item) => item._id === workflowProjectId)?.name || draft.name,
        })}>
          <option value="">Use client-level suggestions</option>
          {data.projects.filter((item) => item.client === draft.clientId).map((item) => <option key={item._id} value={item._id}>{item.name}</option>)}
        </Select>
        <TextField label="Daily Work project name" value={draft.name} set={field('name')} required maxLength={120} />
      </div>
    </Form>
    <Select label="Manage project" value={active?._id} set={(id) => { select(id); setRenaming(null); }}>
      <option value="">Select project</option>
      {data.dailyProjects.map((item) => <option key={item._id} value={item._id}>{item.name}{item.archived ? ' (archived)' : ''}</option>)}
    </Select>
    {active && (renaming === null ? <div className="row-wrap">
      <button className="btn btn-sm" onClick={() => setRenaming(active.name)}>Rename</button>
      <button className="btn btn-sm" onClick={() => save(`/projects/${active._id}`, 'PATCH', { archived: !active.archived }, active.archived ? 'Project restored.' : 'Project archived.')}>
        {active.archived ? 'Restore' : 'Archive'}
      </button>
    </div> : <Form submit={async () => { if (await save(`/projects/${active._id}`, 'PATCH', { name: renaming }, 'Project renamed.')) setRenaming(null); }}
      cancel={() => setRenaming(null)}><TextField label="Project name" value={renaming} set={setRenaming} maxLength={120} required /></Form>)}
  </section>;
}

function Catalog({ project, items, save }) {
  const [task, field, setTask] = useForm(editingItem);
  const [text, setText] = useState('');
  const [importError, setImportError] = useState(null);
  return <section className="card daily-card stack">
    <h2>Task Name &amp; Description</h2>
    <Form label={task._id ? 'Update task' : 'Add task'} cancel={task._id ? () => setTask(editingItem) : undefined} submit={async () => {
      const { title, hours, description } = task;
      const result = await save(task._id ? `/catalog/${task._id}` : `/projects/${project._id}/catalog`, task._id ? 'PATCH' : 'POST',
        { title, hours, description }, 'Catalog task saved.');
      if (result) setTask(editingItem);
    }}>
      <div className="row-wrap daily-controls">
        <TextField label="Task name" value={task.title} set={field('title')} required maxLength={230} />
        <TextField label="Required hours" value={task.hours} set={field('hours')} type="number" min="0" max="24" step="0.01" required />
      </div>
      <label className="field"><span>Description</span><textarea className="input" value={input(task.description)} maxLength={800}
        onChange={(event) => field('description')(event.target.value)} /></label>
    </Form>
    {items.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Task</th><th>Description</th><th>Hours</th><th aria-label="Actions" /></tr></thead>
      <tbody>{items.map((item) => <tr key={item._id}><td>{item.title} {item.archived && <Badge>Archived</Badge>}</td>
        <td>{item.description || '—'}</td><td>{item.hours}</td><td><div className="row-wrap">
          <button className="btn btn-sm" onClick={() => setTask(item)}>Edit</button>
          <button className="btn btn-sm" onClick={() => save(`/catalog/${item._id}`, 'PATCH', { archived: !item.archived }, item.archived ? 'Task restored.' : 'Task archived.')}>
            {item.archived ? 'Restore' : 'Archive'}
          </button></div></td></tr>)}</tbody></table></div> : <Empty title="No catalog tasks for this project" />}
    <details><summary>Import tasks from a spreadsheet</summary>
      <div className="stack daily-import">
        <p className="muted">Paste up to 200 rows without headers. Copy three columns in this order: task name, hours, description. Existing task names are updated.</p>
        <ErrorBox error={importError} />
        <Form label="Import tasks" submit={async () => {
          setImportError(null);
          const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('\t'));
          if (!rows.length || rows.some((row) => row.length < 2 || row.length > 3)) {
            setImportError(new Error('Copy task name, hours, and optional description as separate spreadsheet columns.'));
            return;
          }
          const result = await save(`/projects/${project._id}/catalog`, 'POST', {
            items: rows.map(([title, hours, description]) => ({ title, hours, description })),
          }, 'Catalog tasks imported.');
          if (result) setText('');
        }}><label className="field"><span>Spreadsheet rows</span><textarea className="input" rows={5} value={text} required
          onChange={(event) => setText(event.target.value)} /></label></Form>
      </div>
    </details>
  </section>;
}

function MemberSelect({ members, value, set }) {
  return <Select label="Employee" value={value} set={set} required>
    <option value="">Select employee</option>
    {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
  </Select>;
}

function Distribution({ project, members, assignments, save }) {
  const [memberId, setMember] = useState('');
  const [hours, setHours] = useState('');
  const names = new Map(members.map((member) => [member.id, member.name]));
  const path = (id) => `/projects/${project._id}/members/${id}`;
  return <section className="card daily-card stack">
    <h2>Work distribution</h2>
    <Form label="Save assignment" submit={async () => { await save(path(memberId), 'PUT', { hours }, 'Assignment saved.'); }}>
      <div className="row-wrap daily-controls"><MemberSelect members={members} value={memberId} set={(id) => {
        setMember(id); setHours(assignments.find((assignment) => assignment.memberId === id)?.hours ?? '');
      }} />
        <TextField label="Hours" type="number" min="0" max="24" step="0.01" value={hours} set={setHours} required />
      </div>
    </Form>
    {assignments.length > 0 && <div className="table-wrap"><table className="table"><thead><tr><th>Employee</th><th>Hours</th><th aria-label="Actions" /></tr></thead>
      <tbody>{assignments.map((row) => <tr key={row._id}><td>{names.get(row.memberId) || 'Inactive employee'}</td><td>{row.hours}</td>
        <td><button className="btn btn-sm" onClick={() => save(path(row.memberId), 'PUT', { remove: true }, 'Assignment removed.')}>Remove</button></td></tr>)}</tbody>
    </table></div>}
  </section>;
}

function EmployeeForm({ member, save, superAdmin }) {
  const [settings, field] = useForm(member);
  const [leave, setLeave] = useState('');
  return <>
    <Form label="Save reporting settings" submit={async () => { await save(`/members/${member.id}`, 'PUT', settings, 'Reporting settings saved.'); }}>
      <div className="row-wrap daily-controls">
        <label className="row"><input type="checkbox" checked={settings.enrolled} onChange={(event) => field('enrolled')(event.target.checked)} /> Include in reports</label>
        <Select label="Shift" value={settings.shift} set={field('shift')}><option value="morning">Morning</option><option value="afternoon">Afternoon</option></Select>
        <TextField label="Date for Message" type="date" value={settings.reportFrom} set={field('reportFrom')} />
      </div>
      {superAdmin && <div className="row-wrap daily-controls">
        <TextField label="Hubstaff user ID" inputMode="numeric" value={settings.hubstaffUserId} set={field('hubstaffUserId')} />
        <label className="row"><input type="checkbox" checked={!!settings.hubstaffAccess} onChange={(event) => field('hubstaffAccess')(event.target.checked)} /> Show Hubstaff tab</label>
      </div>}
    </Form>
    <Form label="Add leave date" submit={async () => {
      if (await save(`/members/${member.id}/leave/${leave}`, 'PUT', {}, 'Leave recorded.')) setLeave('');
    }}><TextField label="Leave date" type="date" value={leave} set={setLeave} required /></Form>
  </>;
}

function Employees({ data, save, superAdmin }) {
  const [memberId, setMember] = useState('');
  const member = data.members.find((item) => item.id === memberId);
  return <section className="card daily-card stack">
    <h2>Manage employees</h2>
    <MemberSelect members={data.members} value={memberId} set={setMember} />
    {member && <>
      <EmployeeForm key={member.id} member={member} save={save} superAdmin={superAdmin} />
      {data.leave.filter((row) => row.memberId === member.id).map((row) => <div className="row-wrap" key={row._id}>
        <span>{row.date}</span><button className="btn btn-sm" onClick={() => save(
          `/members/${member.id}/leave/${row.date}`, 'PUT', { remove: true }, 'Leave removed.',
        )}>Remove leave</button>
      </div>)}
    </>}
  </section>;
}

export function ManageDailyWork({ onSaved }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi(`${root}/manage`);
  const [projectId, setProject] = useState('');
  const [saveError, setSaveError] = useState(null);
  const toast = useToast();
  const active = data?.dailyProjects.find((project) => project._id === projectId);
  async function save(path, method, body, message) {
    setSaveError(null);
    try {
      const result = await api(root + path, { method, body });
      reload();
      onSaved();
      toast(message);
      return result;
    } catch (error) { setSaveError(error); return null; }
  }
  if (!data && loading) return <Skeleton />;
  if (!data) return <ErrorBox error={error} />;
  return <div className="stack">
    <ErrorBox error={saveError || error} />
    <ProjectSetup data={data} save={save} active={active} select={setProject} />
    {active && <>
      <Catalog key={`catalog-${active._id}`} project={active} items={data.catalog.filter((row) => row.projectId === active._id)} save={save} />
      <Distribution key={`distribution-${active._id}`} project={active} members={data.members}
        assignments={data.assignments.filter((row) => row.projectId === active._id)} save={save} />
    </>}
    <Employees data={data} save={save} superAdmin={can.super} />
  </div>;
}

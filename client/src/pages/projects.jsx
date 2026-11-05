import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Building2, FolderKanban, Plus, Pencil, ExternalLink, ShieldCheck } from 'lucide-react';
import { api, useApi, usePaginatedTasks, useToast } from '../lib.jsx';
import { TaskDrawer, TaskForm, TaskListCard, TaskPagination, useTaskToggle } from '../tasks.jsx';
import { Empty, ErrorBox, Modal, PageHead, Skeleton } from '../ui.jsx';

const lines = text => text.split('\n').map(s => s.trim()).filter(Boolean);
const rows = text => lines(text).map(s => s.split(' | ').map(v => v.trim()));
const linkLabel = l => l.restricted ? l.label + ' · managers only' : l.label;
const safeUrl = s => /^https:\/\//i.test(s || '') ? s : null;
const group = (title, children) => <section className="card card-pad stack" style={{ gap: 12 }}>
  <h3>{title}</h3>{children}
</section>;
function PersonList({ people = [] }) {
  return people.length ? <div className="stack" style={{ gap: 10 }}>{people.map((p, i) => <div key={i}>
    <strong>{p.name}</strong> <span className="small muted">· {p.role || 'Team member'}</span>
    {p.email && <div className="small"><a href={'mailto:' + p.email}>{p.email}</a></div>}
    {safeUrl(p.profileUrl) && <div className="small"><a href={p.profileUrl} target="_blank" rel="noopener noreferrer">Profile ↗</a></div>}
  </div>)}</div> : <p className="muted small">Not entered yet.</p>;
}
function BulletList({ values = [] }) {
  return values.length ? <ul style={{ paddingLeft: 22, margin: 0 }}>{values.map((v, i) => <li key={i} style={{ marginBottom: 6 }}>{v}</li>)}</ul>
    : <p className="muted small">Not entered yet.</p>;
}
const joinRows = (items = [], keys) => items.map(v => keys.map(k => v[k] || '').join(' | ')).join('\n');
function ProjectEditor({ project, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: project.name || '', description: project.description || '', businessType: project.businessType || '',
    website: project.website || '', notes: project.notes || '',
    contacts: joinRows(project.contacts, ['name','role','email']),
    team: joinRows(project.team, ['name','role','profileUrl']),
    scope: (project.scope || []).join('\n'),
    excluded: (project.excluded || []).join('\n'),
    links: joinRows(project.links, ['label','url','restricted']),
    tools: joinRows(project.tools, ['name','purpose','url']),
    automations: (project.automations || []).join('\n'),
    guarantees: (project.guarantees || []).join('\n'),
    quality: (project.quality || []).map(g => '## ' + g.title + '\n' + (g.items || []).join('\n')).join('\n\n'),
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const quality = () => {
    const groups = []; let current;
    for (const l of lines(form.quality)) {
      if (l.startsWith('## ')) { current = { title: l.slice(3).trim(), items: [] }; groups.push(current); }
      else if (current) current.items.push(l);
    }
    return groups;
  };
  const submit = async e => {
    e.preventDefault(); setSaving(true); setError(null);
    try {
      const links = rows(form.links).map(([label, url, restricted]) => ({ label, url, restricted: restricted === 'true' }));
      if (links.some(l => !l.label || !safeUrl(l.url))) throw new Error('Links need a label and an https:// URL.');
      const payload = {
        name: form.name, description: form.description, businessType: form.businessType,
        website: form.website, notes: form.notes,
        contacts: rows(form.contacts).map(([name, role, email]) => ({ name, role, email })),
        team: rows(form.team).map(([name, role, profileUrl]) => ({ name, role, profileUrl })),
        scope: lines(form.scope), excluded: lines(form.excluded), links,
        tools: rows(form.tools).map(([name, purpose, url]) => ({ name, purpose, url })),
        automations: lines(form.automations), guarantees: lines(form.guarantees), quality: quality(),
      };
      await api(`/clients/${project.client}/projects/${project._id}`, { method: 'PATCH', body: payload });
      toast('Project updated'); onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const field = (key, label, multiline = false, hint = '') => <label className="stack" key={key} style={{ gap: 5 }}>
    <strong className="small">{label}</strong>
    {multiline ? <textarea className="textarea" rows={3} value={form[key]} onChange={e => set(key, e.target.value)} />
      : <input className="input" value={form[key]} onChange={e => set(key, e.target.value)} />}
    {hint && <span className="small muted">{hint}</span>}
  </label>;
  return <Modal wide title={'Edit project · ' + project.name} onClose={onClose}
    footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="project-editor" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></>}>
    <form id="project-editor" className="stack" style={{ gap: 16 }} onSubmit={submit}>
      <ErrorBox error={error}/>
      {field('name', 'Project name')}
      {field('description', 'Project summary', true)}
      {field('businessType', 'Business type')}
      {field('website', 'Website')}
      {field('contacts', 'Contacts', true, 'One per line: Name | Role | Email')}
      {field('team', 'Project team', true, 'One per line: Name | Role | Slack profile URL')}
      {field('scope', 'Scope of work', true, 'One item per line')}
      {field('excluded', 'Out of scope', true, 'One item per line')}
      {field('links', 'Reference links', true, 'One per line: Label | https://link | true (for restricted links). Never store passwords.')}
      {field('tools', 'Applications', true, 'One per line: Name | Purpose | Optional https://link')}
      {field('automations', 'Automation', true, 'One item per line')}
      {field('quality', 'Quality requirements', true, 'Each group begins ## Title, followed by one requirement per line')}
      {field('guarantees', 'GATP guarantees', true, 'One item per line')}
      {field('notes', 'Other notes', true)}
    </form>
  </Modal>;
}
export function ClientProjects() {
  const { id, projectId } = useParams();
  const client = useApi(`/clients/${id}`, [id]);
  const projects = useApi(`/clients/${id}/projects`, [id]);
  const detail = useApi(projectId ? `/clients/${id}/projects/${projectId}` : null, [id, projectId]);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(null);
  const [workView, setWorkView] = useState('open');
  const [openTask, setOpenTask] = useState(null);
  const tasks = usePaginatedTasks(`scope=all&client=${id}&project=${projectId || 'unassigned'}&view=${workView === 'done' ? 'completed' : workView}`);
  const toggleTask = useTaskToggle(tasks.reload);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState(null);
  const create = async e => {
    e.preventDefault(); setError(null);
    try {
      await api(`/clients/${id}/projects`, { method: 'POST', body: { name: newName, description: newDesc } });
      toast('Project added'); setAdding(false); setNewName(''); setNewDesc(''); projects.reload();
    } catch (err) { setError(err); }
  };
  if (client.error) return <div className="card card-pad"><ErrorBox error={client.error}/></div>;
  const p = detail.data;
  const parent = client.data?.name || 'Client';
  return <>
    <div className="row-wrap small" style={{ marginBottom: 12 }}>
      <Link to="/clients">Clients</Link><span className="muted">/</span>
      <Link to={`/clients/${id}`}>{parent}</Link>
      <span className="muted">/</span>
      {projectId ? <Link to={`/clients/${id}/projects`}>Projects</Link> : <strong>Projects</strong>}
      {projectId && <><span className="muted">/</span><strong>{p?.name || 'Project'}</strong></>}
    </div>
    <PageHead title={projectId ? p?.name || 'Project' : parent + ' · Projects'}
      subtitle={projectId ? 'Project details, responsibilities, procedures and key links' : 'Separate project workspaces under this client.'}>
      {!projectId && client.data?.canManage && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16}/>New project</button>}
      {projectId && client.data?.canManage && p && <>
        <button className="btn btn-outline" onClick={() => setEditing(true)}><Pencil size={15}/>Edit project</button>
        <button className="btn btn-primary" onClick={() => setCreatingTask('once')}><Plus size={16}/>New task</button>
        <button className="btn btn-outline" onClick={() => setCreatingTask('recurring')}><Plus size={16}/>Recurring task</button>
      </>}
    </PageHead>
    {!projectId ? (
      projects.loading ? <div className="card card-pad"><Skeleton/></div> :
      projects.error ? <ErrorBox error={projects.error}/> :
      projects.data?.length ? <div className="grid grid-3">{projects.data.map(project => <Link key={project._id} className="card card-pad" style={{ color: 'var(--text)' }} to={`/clients/${id}/projects/${project._id}`}>
        <div className="row"><FolderKanban size={20}/><strong>{project.name}</strong></div>
        <p className="small muted" style={{ marginTop: 10 }}>{project.description || 'Project details not added yet.'}</p>
        <p className="small" style={{ marginTop: 10 }}>View project →</p>
      </Link>)}</div> : <div className="card card-pad"><Empty icon={FolderKanban} title="No projects yet"/></div>
    ) : detail.loading || !p ? <div className="card card-pad">{detail.error ? <ErrorBox error={detail.error}/> : <Skeleton/>}</div> : <>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row"><Building2 size={16}/><strong>{parent}</strong></div>
        <p style={{ marginTop: 8 }}>{p.description || 'No project summary entered yet.'}</p>
        <div className="row-wrap small muted" style={{ marginTop: 10 }}>
          {p.businessType && <span>Business: {p.businessType}</span>}
          {safeUrl(p.website) && <a href={p.website} target="_blank" rel="noopener noreferrer">Website <ExternalLink size={12} style={{ display: 'inline' }}/></a>}
        </div>
      </div>
      <div className="grid grid-2">
        {group('Client contacts', <PersonList people={p.contacts}/>)}
        {group('Project team', <PersonList people={p.team}/>)}
        {group('Included scope', <BulletList values={p.scope}/>)}
        {group('Out of scope', <BulletList values={p.excluded}/>)}
        {group('Key links', (p.links || []).length ? <div className="stack" style={{ gap: 8 }}>{p.links.map((l,i) =>
          <a key={i} href={safeUrl(l.url) || '#'} target="_blank" rel="noopener noreferrer" className="row small">
            {l.restricted && <ShieldCheck size={14}/>} {linkLabel(l)} <ExternalLink size={12}/>
          </a>)}</div> : <p className="muted small">No links added.</p>)}
        {group('Applications', (p.tools || []).length ? <div className="stack" style={{ gap: 10 }}>{p.tools.map((t,i) => <div key={i}>
          <strong>{t.name}</strong><p className="small muted">{t.purpose}</p>
          {safeUrl(t.url) && <a className="small" href={t.url} target="_blank" rel="noopener noreferrer">Guide ↗</a>}
        </div>)}</div> : <p className="muted small">Not entered yet.</p>)}
        {group('Automations', <BulletList values={p.automations}/>)}
        {group('GATP guarantees', <BulletList values={p.guarantees}/>)}
        {(p.quality || []).map((g,i) => <div key={i}>{group('Quality · '+g.title, <BulletList values={g.items}/>)}</div>)}
        {p.notes && group('Other notes', <p style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</p>)}
      </div>
    </>}
    {adding && <Modal title="New client project" onClose={() => setAdding(false)} footer={<>
      <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" form="new-project" disabled={!newName.trim()}>Create project</button>
    </>}><form id="new-project" className="stack" onSubmit={create}>
      <ErrorBox error={error}/>
      <label>Project name<input className="input" required maxLength={120} value={newName} onChange={e => setNewName(e.target.value)}/></label>
      <label>Summary<textarea className="textarea" rows={3} value={newDesc} onChange={e => setNewDesc(e.target.value)}/></label>
    </form></Modal>}
    {editing && p && <ProjectEditor project={p} onClose={() => setEditing(false)} onSaved={() => { detail.reload(); projects.reload(); setEditing(false); }} />}
  </>;
}

import { useMemo, useState } from 'react';
import { Plus, Pencil, Archive, ExternalLink, Link2, Search, BookOpen, Clock3 } from 'lucide-react';
import { api, useApi, useToast } from '../lib.jsx';
import { ErrorBox, Modal, Skeleton } from '../ui.jsx';

const initial = {
  title: '', category: 'Bookkeeping & Operations', frequency: '', executionDay: '',
  responsible: '', weeklyHours: '', software: '', automated: false, reminder: '', notes: '',
  links: [],
};
const basePath = (clientId, projectId) => `/clients/${clientId}/projects/${projectId}/work-items`;
const validUrl = value => {
  try { const parsed = new URL(value); return parsed.protocol === 'https:'; } catch { return false; }
};
function WorkEditor({ item, clientId, projectId, onSaved, onClose }) {
  const editing = !!item;
  const [f, setF] = useState(() => item ? {
    ...initial, ...item, links: (item.links || []).map(l => ({ label: l.label, url: l.url })),
  } : { ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();
  const set = (key, value) => setF(v => ({ ...v, [key]: value }));
  const setLink = (index, key, value) => setF(v => ({
    ...v, links: v.links.map((l, i) => i === index ? { ...l, [key]: value } : l),
  }));
  const field = (key, label, hint = '') => <label key={key} className="stack" style={{ gap: 4 }}>
    <strong className="small">{label}</strong>
    <input className="input" value={f[key] || ''} onChange={e => set(key, e.target.value)} placeholder={hint} />
  </label>;
  const save = async e => {
    e.preventDefault(); setError(null);
    const links = f.links.filter(l => l.label.trim() || l.url.trim());
    if (links.some(l => !l.label.trim() || !validUrl(l.url.trim()))) {
      setError(new Error('Each reference needs a title and a valid https:// URL.')); return;
    }
    setSaving(true);
    try {
      const path = basePath(clientId, projectId) + (editing ? '/' + item._id : '');
      await api(path, { method: editing ? 'PATCH' : 'POST', body: { ...f, links } });
      toast(editing ? 'Task details and links updated' : 'Project task added');
      onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return <Modal wide title={editing ? 'Edit project task' : 'Add important project task'} onClose={onClose}
    footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="project-work-editor" disabled={saving || !f.title.trim()}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add task'}</button></>}>
    <form id="project-work-editor" className="stack" style={{ gap: 16 }} onSubmit={save}>
      <ErrorBox error={error}/>
      <div className="form-note">This task register documents scope, responsibilities and reference links. To assign dated work to employees, use New task or Recurring task on the project page.</div>
      {field('title','Task name','e.g. Weekly AP / AR review')}
      <div className="grid grid-2">
        {field('category','Category')}
        {field('responsible','Responsible person')}
        {field('frequency','Frequency','Daily, Weekly, Monthly, As needed')}
        {field('executionDay','Execution day','e.g. Friday')}
        {field('weeklyHours','Estimated hours','e.g. 1 hour')}
        {field('software','Software','e.g. QBD, Gusto')}
      </div>
      <label className="row-wrap"><input type="checkbox" checked={!!f.automated} onChange={e => set('automated', e.target.checked)} /> <strong className="small">Automation available</strong></label>
      {field('reminder','Reminder / source status (optional)')}
      <label className="stack"><strong className="small">Instructions / notes</strong>
        <textarea className="textarea" rows={3} value={f.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Any important information, handoff or scheduling clarification"/>
      </label>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <h3>Task links and documents</h3>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => set('links', [...f.links, { label: '', url: '' }])}><Plus size={15}/> Add link</button>
      </div>
      <p className="small muted">Add SOPs, Loom or Tango tutorials, Karbon references, Google Sheets, or other important HTTPS links. Do not store passwords here.</p>
      {f.links.length === 0 && <p className="small muted">No task-specific links yet.</p>}
      {f.links.map((link, i) => <div key={i} className="row-wrap" style={{ alignItems: 'center', gap: 8 }}>
        <input aria-label={'Link label '+(i+1)} className="input" style={{ flex: '1 1 150px' }} value={link.label} placeholder="SOP / Loom / Important link" onChange={e => setLink(i, 'label', e.target.value)} />
        <input aria-label={'Link URL '+(i+1)} className="input" style={{ flex: '2 1 260px' }} value={link.url} placeholder="https://..." onChange={e => setLink(i, 'url', e.target.value)} />
        <button type="button" className="btn btn-outline btn-sm" aria-label="Remove link" onClick={() => set('links', f.links.filter((_, j) => j !== i))}>Remove</button>
      </div>)}
    </form>
  </Modal>;
}
export default function ProjectWorkRegister({ clientId, projectId, canManage }) {
  const url = basePath(clientId, projectId);
  const register = useApi(url, [clientId, projectId]);
  const [q, setQ] = useState('');
  const [frequency, setFrequency] = useState('all');
  const [editing, setEditing] = useState(undefined);
  const [savingDelete, setSavingDelete] = useState(null);
  const toast = useToast();
  const data = register.data || [];
  const options = [...new Set(data.map(d => d.frequency).filter(Boolean))].sort();
  const filtered = useMemo(() => data.filter(d => {
    const text = [d.title,d.category,d.responsible,d.software,d.notes].join(' ').toLowerCase();
    return text.includes(q.toLowerCase()) && (frequency === 'all' || d.frequency === frequency);
  }), [data,q,frequency]);
  const archive = async item => {
    if (!window.confirm('Archive “' + item.title + '” from the master task list? Existing dated tasks and their history will remain.')) return;
    setSavingDelete(item._id);
    try {
      await api(url + '/' + item._id, { method: 'DELETE' });
      toast('Task archived from register'); register.reload();
    } catch (err) { toast(err.message); } finally { setSavingDelete(null); }
  };
  return <section style={{ marginBottom: 28 }}>
    <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
      <div><h2>Master task list</h2><p className="small muted">All project work, responsibilities, frequency and task-specific references — not just what is due today.</p></div>
      {canManage && <button className="btn btn-primary" onClick={() => setEditing(null)}><Plus size={16}/>Add important task</button>}
    </div>
    <div className="row-wrap" style={{ marginBottom: 14 }}>
      <div className="search" style={{ flex: '1 1 220px', maxWidth: 390 }}><Search size={16}/><input className="input" placeholder="Search project tasks, software or person..." value={q} onChange={e => setQ(e.target.value)}/></div>
      <select className="select" style={{ maxWidth: 260 }} value={frequency} onChange={e => setFrequency(e.target.value)} aria-label="Task frequency">
        <option value="all">All frequencies</option>{options.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
      <span className="small muted">{filtered.length} of {data.length} work items</span>
    </div>
    {register.error && <ErrorBox error={register.error}/>}
    {register.loading && !register.data ? <div className="card card-pad"><Skeleton rows={4}/></div> :
    !filtered.length ? <div className="card card-pad"><p className="muted">No matching master tasks. {canManage ? 'Use Add important task to add one.' : ''}</p></div> :
    <div className="card" style={{ overflow: 'hidden' }}><div className="table-wrap">
      <table>
        <thead><tr><th style={{ minWidth: 220 }}>Task / responsibility</th><th>Frequency / execution</th><th>Software & time</th><th>References</th>{canManage && <th>Manage</th>}</tr></thead>
        <tbody>{filtered.map(item => <tr key={item._id}>
          <td><strong>{item.title}</strong>
            {item.category === 'Payroll' && <div className="small muted">Payroll</div>}
            <div className="small muted" style={{ marginTop: 5 }}>{item.responsible ? 'Owner: ' + item.responsible : 'Owner not specified'}</div>
            {item.automated && <span className="small" style={{ color: 'var(--success)' }}>Automation noted</span>}
            {item.notes && <div className="small muted" style={{ marginTop: 4 }}>{item.notes}</div>}
          </td>
          <td><div className="row small"><Clock3 size={13}/>{item.frequency || 'Not specified'}</div><div className="small muted" style={{ marginTop: 4 }}>{item.executionDay || 'Day not specified'}</div></td>
          <td><div className="small">{item.software || '—'}</div><div className="small muted" style={{ marginTop: 5 }}>{item.weeklyHours || '—'}</div></td>
          <td>{(item.links || []).length ? <div className="stack" style={{ gap: 5 }}>
            {item.links.map((l,i) => <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" className="row small" style={{ gap: 5 }}><Link2 size={13}/>{l.label}<ExternalLink size={11}/></a>)}
          </div> : <span className="small muted">No links</span>}</td>
          {canManage && <td><div className="row-wrap">
            <button className="btn btn-outline btn-sm" onClick={() => setEditing(item)}><Pencil size={14}/>Edit</button>
            <button className="btn btn-ghost btn-sm" disabled={savingDelete === item._id} onClick={() => archive(item)}><Archive size={14}/>Archive</button>
          </div></td>}
        </tr>)}</tbody>
      </table>
    </div></div>}
    {editing !== undefined && <WorkEditor item={editing} clientId={clientId} projectId={projectId}
      onClose={() => setEditing(undefined)} onSaved={() => { register.reload(); setEditing(undefined); }} />}
  </section>;
}

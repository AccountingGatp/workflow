import { useState } from 'react';
import { ArrowUpRight, FolderKanban, Plus, Search, Workflow, Zap } from 'lucide-react';
import { api, useApi, useToast } from '../lib.jsx';
import { Empty, ErrorBox, Modal, PageHead, Skeleton } from '../ui.jsx';

function AddAutomation({ project, available, onClose, onSaved }) {
  const addingProject = !project;
  const [projectId, setProjectId] = useState(available[0]?.id || '');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const close = () => { if (!saving) onClose(); };

  async function save(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (addingProject) await api(`/automations/${projectId}`, { method: 'PUT' });
      else await api(`/automations/${project.id}/links`, { method: 'POST', body: { name, url } });
      onSaved(addingProject ? projectId : null);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={addingProject ? 'Add project' : `Add automation · ${project.name}`} onClose={close}
    footer={<>
      <button type="button" className="btn btn-ghost" disabled={saving} onClick={close}>Cancel</button>
      <button type="submit" form="automation-form" className="btn btn-primary"
        disabled={saving || (addingProject ? !projectId : !name.trim() || !url.trim())}>
        {saving ? 'Saving…' : addingProject ? 'Add project' : 'Add automation'}
      </button>
    </>}>
    <form id="automation-form" className="stack" onSubmit={save}>
      <ErrorBox error={error} />
      {addingProject ? <label className="field">
        <span>Workflow project</span>
        <select className="select" value={projectId} onChange={(event) => setProjectId(event.target.value)} required autoFocus>
          {available.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label> : <>
        <label className="field"><span>Automation name</span>
          <input className="input" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </label>
        <label className="field"><span>Automation URL</span>
          <input className="input" type="url" placeholder="https://" maxLength={2048} value={url}
            onChange={(event) => setUrl(event.target.value)} required />
        </label>
      </>}
    </form>
  </Modal>;
}

export default function Automations() {
  const catalog = useApi('/automations');
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [adding, setAdding] = useState(null);
  const rows = catalog.data || [];
  const projects = rows.filter((project) => project.links !== null);
  const available = rows.filter((project) => project.canEdit && project.links === null);
  const query = search.trim().toLowerCase();
  const visible = projects.flatMap((project) => {
    if (projectFilter && project.id !== projectFilter) return [];
    if (!query || project.name.toLowerCase().includes(query)) return [project];
    const links = project.links.filter((link) => link.name.toLowerCase().includes(query));
    return links.length ? [{ ...project, links }] : [];
  });

  function saved(projectId) {
    catalog.reload();
    setAdding(null);
    if (projectId) {
      setProjectFilter(projectId);
      setSearch('');
    }
    toast(projectId ? 'Project added to Automations' : 'Automation added');
  }

  return <>
    <PageHead title="Automations" subtitle="Launch your project’s automation tools from one place.">
      {!!available.length && <button type="button" className="btn btn-primary" onClick={() => setAdding({})}>
        <Plus size={18} />Add project
      </button>}
    </PageHead>
    <ErrorBox error={catalog.error} />
    {catalog.loading ? <Skeleton rows={3} /> : !catalog.error && <>
      {!!projects.length && <div className="automation-filters row-wrap">
        <div className="search">
          <Search size={17} aria-hidden="true" />
          <input className="input" type="search" aria-label="Search automations" placeholder="Search projects and automations"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <select className="select" aria-label="Filter by project" value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}>
          <option value="">All projects</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>}
      {!visible.length && <div className="card"><Empty icon={Workflow}
        title={projects.length ? 'No matching automations' : 'No automation projects yet'} /></div>}
      <div className="automation-groups">
        {visible.map((project) => <section className="automation-group" key={project.id} aria-labelledby={`automation-${project.id}`}>
          <div className="row-wrap automation-group-head">
            <span className="automation-project-icon"><FolderKanban size={21} aria-hidden="true" /></span>
            <h2 id={`automation-${project.id}`}>{project.name}</h2>
            {project.canEdit && <button type="button" className="btn btn-outline btn-sm" onClick={() => setAdding({ project })}>
              <Plus size={16} />Add automation
            </button>}
          </div>
          {project.links.length ? <div className="automation-grid">
            {project.links.map((link) => <a className="card automation-card" key={link.url}
              href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${link.name} in a new tab`}>
              <span className="automation-tool-icon"><Zap size={19} aria-hidden="true" /></span>
              <span className="automation-card-label">
                <strong>{link.name}</strong>
                <span className="small muted">{new URL(link.url).hostname}</span>
              </span>
              <ArrowUpRight className="automation-arrow" size={18} aria-hidden="true" />
            </a>)}
          </div> : <div className="card"><Empty icon={Zap} title="No automation links yet" /></div>}
        </section>)}
      </div>
    </>}
    {adding && <AddAutomation project={adding.project} available={available} onClose={() => setAdding(null)} onSaved={saved} />}
  </>;
}

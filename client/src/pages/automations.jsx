import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, FolderKanban, Pencil, Plus, Search, Workflow, Zap } from 'lucide-react';
import { api, useApi, useToast } from '../lib.jsx';
import { Empty, ErrorBox, Modal, PageHead, Skeleton } from '../ui.jsx';

function AutomationForm({ project, link, available, onClose, onSaved }) {
  const addingProject = !project;
  const [projectId, setProjectId] = useState(available[0]?.id || '');
  const [name, setName] = useState(link?.name || '');
  const [url, setUrl] = useState(link?.url || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const close = () => { if (!saving) onClose(); };

  async function save(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (addingProject) await api(`/automations/${projectId}`, { method: 'PUT' });
      else await api(`/automations/${project.id}/links` + (link ? '/' + link._id : ''),
        { method: link ? 'PATCH' : 'POST', body: { name, url } });
      onSaved(addingProject ? projectId : null, !!link);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={addingProject ? 'Add project' : link ? 'Edit automation' : `Add automation · ${project.name}`} onClose={close}
    footer={<>
      <button type="button" className="btn btn-ghost" disabled={saving} onClick={close}>Cancel</button>
      <button type="submit" form="automation-form" className="btn btn-primary"
        disabled={saving || (addingProject ? !projectId : !name.trim() || !url.trim())}>
        {saving ? 'Saving…' : addingProject ? 'Add project' : link ? 'Save changes' : 'Add automation'}
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
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const rows = catalog.data || [];
  const projects = rows.filter((project) => project.links !== null);
  const available = rows.filter((project) => project.canEdit && project.links === null);
  const projectId = params.get('project');
  const project = projects.find((item) => item.id === projectId);
  const query = search.trim().toLowerCase();
  const visible = projects.filter((item) => item.name.toLowerCase().includes(query));

  function saved(addedProjectId, edited) {
    catalog.reload();
    setForm(null);
    if (addedProjectId) setParams({ project: addedProjectId });
    toast(addedProjectId ? 'Project added to Automations' : edited ? 'Automation updated' : 'Automation added');
  }

  return <>
    {projectId && <Link className="btn btn-ghost btn-sm automation-back" to="/automations">
      <ArrowLeft size={16} />All automation projects
    </Link>}
    <PageHead title={project?.name || 'Automations'} subtitle={projectId ? undefined : 'Choose a project to open its automation tools.'}>
      {!projectId && !!available.length && <button type="button" className="btn btn-primary" onClick={() => setForm({})}>
        <Plus size={18} />Add project
      </button>}
      {project?.canEdit && <button type="button" className="btn btn-primary" onClick={() => setForm({ project })}>
        <Plus size={18} />Add automation
      </button>}
    </PageHead>
    <ErrorBox error={catalog.error} />
    {catalog.loading ? <Skeleton rows={3} /> : !catalog.error && (projectId ? (
      !project ? <div className="card"><Empty icon={FolderKanban} title="Automation project unavailable" /></div> :
        project.links.length ? <div className="automation-grid">
          {project.links.map((link) => <div className="card automation-card-wrap" key={link._id}>
            <a className="automation-card" href={link.url} target="_blank" rel="noopener noreferrer"
              aria-label={`Open ${link.name} in a new tab`}>
              <span className="automation-tool-icon"><Zap size={19} aria-hidden="true" /></span>
              <span className="automation-card-label">
                <strong>{link.name}</strong>
                <span className="small muted">{new URL(link.url).hostname}</span>
              </span>
              <ArrowUpRight className="automation-arrow" size={18} aria-hidden="true" />
            </a>
            {project.canEdit && <button type="button" className="btn btn-ghost btn-sm automation-edit"
              aria-label={`Edit ${link.name}`} onClick={() => setForm({ project, link })}>
              <Pencil size={14} />Edit
            </button>}
          </div>)}
        </div> : <div className="card"><Empty icon={Zap} title="No automation links yet" /></div>
    ) : <>
      {!!projects.length && <div className="automation-filters">
        <div className="search">
          <Search size={17} aria-hidden="true" />
          <input className="input" type="search" aria-label="Search automation projects" placeholder="Search projects"
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
      </div>}
      {!visible.length && <div className="card"><Empty icon={Workflow}
        title={projects.length ? 'No matching projects' : 'No automation projects yet'} /></div>}
      <div className="automation-grid">
        {visible.map((item) => <Link className="card automation-project-card" key={item.id}
          to={`/automations?project=${item.id}`}>
          <span className="automation-project-icon"><FolderKanban size={21} aria-hidden="true" /></span>
          <span className="automation-card-label">
            <strong>{item.name}</strong>
            <span className="small muted">{item.links.length} {item.links.length === 1 ? 'automation' : 'automations'}</span>
          </span>
          <ArrowRight className="automation-arrow" size={19} aria-hidden="true" />
        </Link>)}
      </div>
    </>)}
    {form && <AutomationForm project={form.project} link={form.link} available={available}
      onClose={() => setForm(null)} onSaved={saved} />}
  </>;
}

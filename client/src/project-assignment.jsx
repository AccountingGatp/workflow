import { useState } from 'react';
import { FolderKanban, Search, UserPlus } from 'lucide-react';
import { api, useApi, useToast } from './lib.jsx';
import { Badge, Empty, ErrorBox, Modal, Skeleton } from './ui.jsx';

export function ProjectAssignment({ project, person, onClose }) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState(null);
  const [added, setAdded] = useState([]);
  const [error, setError] = useState(null);
  const toast = useToast();
  const projectPath = (item) => `/clients/${item.client}/projects/${item._id}/people`;
  const { data, loading, error: loadError } = useApi(project ? projectPath(project) : `/users/${person._id}/projects`);
  const label = project ? 'people' : 'projects';
  const Icon = project ? UserPlus : FolderKanban;
  const query = search.trim().toLowerCase();
  const rows = (data || []).filter((item) => !project || item.role !== 'super_admin')
    .filter((item) => `${item.name} ${item.email || item.clientName || ''}`.toLowerCase().includes(query));
  const close = () => { if (!pending) onClose(); };

  async function assign(item) {
    setPending(item._id);
    setError(null);
    try {
      await api(`${projectPath(project || item)}/${(person || item)._id}`, { method: 'PUT' });
      setAdded((previous) => [...previous, item._id]);
      toast('Project access added');
    } catch (error) {
      setError(error);
    } finally {
      setPending(null);
    }
  }

  return <Modal title={project ? 'Assign people' : 'Assign projects'} onClose={close} footer={
    <button type="button" className="btn btn-outline" onClick={close} disabled={!!pending}>Done</button>
  }>
    <div className="stack">
      <p><strong>{(project || person).name}</strong></p>
      <div className="search">
        <Search size={16} aria-hidden="true" />
        <input type="search" className="input" aria-label={`Search ${label}`}
          placeholder={project ? 'Search by name or email' : 'Search by project or client'}
          autoFocus value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <ErrorBox error={error || loadError} />
      {loading && !data ? <Skeleton /> : data && (rows.length ? (
        <ul className="assignment-list" aria-label={project ? 'People available for this project' : 'Project access'}>
          {rows.map((item) => {
            const hasAccess = item.assigned || added.includes(item._id);
            return <li key={item._id}>
              <div><strong>{item.name}</strong><div className="small muted">{item.email || item.clientName}</div></div>
              {hasAccess ? <Badge cls="b-success">Has access</Badge> :
                <button type="button" className="btn btn-outline btn-sm" aria-label={`Assign ${item.name}`}
                  onClick={() => assign(item)} disabled={!!pending}>
                  {pending === item._id ? 'Adding…' : 'Assign'}
                </button>}
            </li>;
          })}
        </ul>
      ) : <Empty icon={Icon} title={query ? `No matching ${label}` : `No ${label} available`} />)}
    </div>
  </Modal>;
}

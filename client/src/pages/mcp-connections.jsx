import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fmtDate, useApi, useAuth, useToast } from '../lib.jsx';
import { Badge, ErrorBox, PageHead, Skeleton } from '../ui.jsx';

const path = '/mcp-connections';

function PermissionCheckbox({ label, checked, disabled, onChange, children }) {
  const id = useId();
  return <div>
    <label className="row">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-describedby={id} />
      <strong>{label}</strong>
    </label>
    <p id={id} className="small muted" style={{ marginLeft: 26, marginTop: 4 }}>{children}</p>
  </div>;
}

export function McpConsent() {
  const [params] = useSearchParams();
  const endpoint = `${path}/consent/${encodeURIComponent(params.get('request') || 'missing')}`;
  const { data, error, loading } = useApi(endpoint);
  const { user } = useAuth();
  const [write, setWrite] = useState(false);
  const [allowDelete, setAllowDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);

  async function decide(access) {
    setBusy(true);
    setFailure(null);
    try {
      const { returnTo } = await api(endpoint, { method: 'POST', body: { access, allowDelete: access !== 'deny' && data.allowDelete && allowDelete } });
      window.location.assign(returnTo);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return <>
    <PageHead title="Connect to Workflow" />
    {loading && <Skeleton />}
    <ErrorBox error={failure || error} />
    {data && <section className="card card-pad stack">
      <p><strong>{data.destination}</strong> is requesting access to Workflow as <strong>{user.name}</strong>.</p>
      <fieldset className="reminder-fields stack">
        <legend>Permissions</legend>
        <PermissionCheckbox label="Read" checked disabled>
          Required. View projects, tasks, and Daily Work your account can access.
        </PermissionCheckbox>
        <PermissionCheckbox label="Write" checked={data.allowWrite && write} disabled={busy || !data.allowWrite}
          onChange={(event) => setWrite(event.target.checked)}>
          Create and update tasks. {!data.allowWrite && 'Unavailable for this account or connection request.'}
        </PermissionCheckbox>
        <PermissionCheckbox label="Delete" checked={data.allowDelete && allowDelete} disabled={busy || !data.allowDelete}
          onChange={(event) => setAllowDelete(event.target.checked)}>
          Delete scheduled tasks and historical Daily Work activity. {!data.allowDelete && 'Requires a Super Admin and a connection request that includes Delete.'}
        </PermissionCheckbox>
      </fieldset>
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(data.allowWrite && write ? 'write' : 'read')}>
          Approve connection
        </button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => decide('deny')}>Deny</button>
      </div>
      <p className="small muted">You can revoke this connection from MCP Connections.</p>
    </section>}
    {!loading && !data && <Link to={path}>Back to MCP Connections</Link>}
  </>;
}

export function McpConnections() {
  const { data, error, loading, reload } = useApi(path);
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);

  async function revoke(id) {
    setFailure(null);
    setBusy(id);
    try {
      await api(`${path}/${id}`, { method: 'DELETE' });
      reload();
      toast('MCP connection revoked.');
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(null);
    }
  }

  return <>
    <PageHead title="MCP Connections" />
    <ErrorBox error={failure || error} />
    {loading && <Skeleton />}
    {data && <div className="stack">
      <section className="card card-pad stack">
        <label className="field">MCP server URL<input className="input" readOnly value={data.url} onFocus={(event) => event.target.select()} /></label>
        <p className="small muted">Enter this URL in your MCP client and sign in to approve access.</p>
      </section>
      <section className="card card-pad stack">
        <h2>Active connections</h2>
        {data.grants.length === 0 && <p className="muted">You have no active MCP connections.</p>}
        {data.grants.map((grant) => <div className="row-wrap" key={grant._id}>
          <Badge>{grant.scopes.map((scope) => ({ 'workflow:read': 'Read', 'workflow:write': 'Write', 'workflow:delete': 'Delete' })[scope]).join(' · ')}</Badge>
          <span>Connected {fmtDate(grant.createdAt)} · expires {fmtDate(grant.expiresAt)}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => revoke(grant._id)}>
            {busy === grant._id ? 'Revoking…' : 'Revoke'}
          </button>
        </div>)}
      </section>
    </div>}
  </>;
}

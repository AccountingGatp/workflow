import { useState } from 'react';
import { api, ROLE_LABEL, useApi, useToast } from './lib.jsx';
import { ErrorBox, Field, Modal } from './ui.jsx';

export function ProjectManagerAssignment({ project, onClose, onSaved }) {
  const accounts = useApi('/project-manager-accounts');
  const current = project.projectManager;
  const [userId, setUserId] = useState(current?.accountVerified ? current.user : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();
  const eligible = accounts.data || [];
  const validSelection = !userId || eligible.some((account) => account._id === userId);

  async function save(event) {
    event.preventDefault();
    if (!validSelection) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/projects/${project._id}/manager`, { method: 'PUT', body: { userId: userId || null } });
      toast(userId ? 'Project manager assigned' : 'Project manager cleared');
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={`Assign manager · ${project.name}`} onClose={onClose}
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
      <button type="submit" className="btn btn-primary" form="assign-project-manager"
        disabled={saving || accounts.loading || !!accounts.error || !validSelection}>{saving ? 'Saving…' : 'Save manager'}</button>
    </>}>
    <form id="assign-project-manager" className="stack" onSubmit={save}>
      <ErrorBox error={error || accounts.error} />
      {current?.name && !current.accountVerified && <p className="small muted">Current roster name: {current.name}. Select their Workflow account to link it.</p>}
      <Field label="Manager account">
        <select className="select" value={userId || ''} onChange={(event) => setUserId(event.target.value)} disabled={saving || accounts.loading}>
          <option value="">No manager</option>
          {userId && !validSelection && <option value={userId} disabled>{current?.name} · Account unavailable</option>}
          {eligible.map((account) => <option key={account._id} value={account._id}>
            {account.name} · {account.email} · {ROLE_LABEL[account.role]}
          </option>)}
        </select>
      </Field>
    </form>
  </Modal>;
}

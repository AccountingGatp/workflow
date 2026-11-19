import { useState } from 'react';
import { Bell, Clock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, useApi, useToast } from '../lib.jsx';
import { Badge, Empty, ErrorBox, Modal, PageHead, Skeleton } from '../ui.jsx';

const path = '/daily-work/settings/reminders';
const newReminder = { name: '', time: '18:35', message: '', enabled: true, notifyChannel: false };
const displayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
const schedule = (time) => time ? `Daily at ${displayTime.format(new Date(`2000-01-01T${time}Z`))} IST` : 'Choose a reminder time';
const deliveryTime = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const deliveryLabels = { sent: 'Sent', sending: 'Sending', failed: 'Delivery failed', uncertain: 'Delivery unconfirmed' };

function reminderDelivery(delivery) {
  if (!delivery) return 'No delivery recorded today';
  return `${deliveryLabels[delivery.state]} · ${deliveryTime.format(new Date(delivery.startedAt))} IST`;
}

function ReminderMessage({ reminder }) {
  return <div className="reminder-message">
    {reminder.notifyChannel && <span className="reminder-mention">@channel</span>}
    {reminder.message || 'Your reminder message will appear here.'}
  </div>;
}

function ReminderEditor({ reminder, onClose, onSaved }) {
  const [draft, setDraft] = useState(reminder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
  const close = () => { if (!saving) onClose(); };

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await api(draft._id ? `${path}/${draft._id}` : path, {
        method: draft._id ? 'PUT' : 'POST', body: draft,
      }));
    } catch (error) {
      setError(error);
      setSaving(false);
    }
  }

  return <Modal wide title={draft._id ? 'Edit Slack reminder' : 'Add Slack reminder'} onClose={close} footer={<>
    <button type="button" className="btn btn-ghost" disabled={saving} onClick={close}>Cancel</button>
    <button type="submit" className="btn btn-primary" form="reminder-editor" disabled={saving || !draft.name.trim() || !draft.message.trim() || !draft.time}>
      {saving ? 'Saving…' : 'Save reminder'}
    </button>
  </>}>
    <form id="reminder-editor" className="stack" onSubmit={save}>
      <ErrorBox error={error} />
      <fieldset className="reminder-fields stack" disabled={saving}>
        <div className="grid grid-2">
          <label className="field">Reminder name<input className="input" autoFocus required maxLength={80}
            value={draft.name} onChange={(event) => set('name', event.target.value)} /></label>
          <label className="field">Daily send time (IST)<input className="input" type="time" required
            value={draft.time} onChange={(event) => set('time', event.target.value)} /></label>
        </div>
        <label className="field">Slack message<textarea className="textarea" required maxLength={1000} rows={4}
          value={draft.message} onChange={(event) => set('message', event.target.value)} /></label>
        <label className="row"><input type="checkbox" checked={draft.enabled}
          onChange={(event) => set('enabled', event.target.checked)} /> Enable reminder</label>
        <label className="row"><input type="checkbox" checked={draft.notifyChannel}
          onChange={(event) => set('notifyChannel', event.target.checked)} /> Notify everyone with @channel</label>
      </fieldset>
      <section className="reminder-preview stack" aria-label="Slack message preview">
        <div className="row-wrap reminder-preview-head"><strong>Slack preview</strong><span className="small muted">{schedule(draft.time)}</span></div>
        <ReminderMessage reminder={draft} />
      </section>
    </form>
  </Modal>;
}

export default function Settings() {
  const { data, error, loading, reload } = useApi(path);
  const [saved, setSaved] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const toast = useToast();
  const current = saved || data;
  const closeDelete = () => { if (!removing) setDeleting(null); };

  async function deleteReminder() {
    setRemoving(true);
    setDeleteError(null);
    try {
      setSaved(await api(`${path}/${deleting._id}`, { method: 'DELETE' }));
      setDeleting(null);
      toast('Reminder deleted.');
    } catch (error) {
      setDeleteError(error);
    } finally {
      setRemoving(false);
    }
  }

  return <>
    <PageHead title="Settings" />
    <section className="stack" aria-labelledby="slack-reminders">
      <div className="row-wrap reminder-section-head">
        <div><h2 id="slack-reminders">Slack reminders</h2>
          <p className="small muted">Daily messages to the configured Daily Work channel. Times are in India Standard Time.</p></div>
        <div className="row-wrap">
          <button type="button" className="btn" onClick={() => { setSaved(null); reload(); }}><RefreshCw size={16} /> Refresh status</button>
          <button type="button" className="btn btn-primary" disabled={!current} onClick={() => setEditing(newReminder)}><Plus size={16} /> Add reminder</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {loading && <Skeleton rows={2} />}
      {current && !current.slackConfigured && <p className="form-note">Set up the Daily Work Slack bot and channel to start sending reminders.</p>}
      {current?.reminders.length === 0 && <div className="card"><Empty icon={Bell} title="No Slack reminders" /></div>}
      {current?.reminders.map((reminder) => <article key={reminder._id} className="card card-pad stack reminder-card">
        <div className="row-wrap reminder-section-head">
          <div className="row-wrap">
            <Bell size={17} aria-hidden="true" />
            <h3>{reminder.name}</h3>
            <Badge cls={reminder.enabled ? 'b-success' : ''}>{reminder.enabled ? 'Enabled' : 'Paused'}</Badge>
          </div>
          <div className="row-wrap">
            <button type="button" className="btn btn-sm" aria-label={`Edit ${reminder.name}`} onClick={() => setEditing(reminder)}><Pencil size={14} /> Edit</button>
            <button type="button" className="btn btn-danger btn-sm" aria-label={`Delete ${reminder.name}`} onClick={() => {
              setDeleteError(null);
              setDeleting(reminder);
            }}><Trash2 size={14} /> Delete</button>
          </div>
        </div>
        <div className="row small muted"><Clock size={14} aria-hidden="true" />{schedule(reminder.time)}</div>
        <ReminderMessage reminder={reminder} />
        <p className="small muted">{reminderDelivery(reminder.delivery)}</p>
      </article>)}
    </section>
    {editing && <ReminderEditor reminder={editing} onClose={() => setEditing(null)} onSaved={(response) => {
      setSaved(response);
      setEditing(null);
      toast('Reminder saved.');
    }} />}
    {deleting && <Modal title="Delete Slack reminder?" onClose={closeDelete} footer={<>
      <button type="button" className="btn" autoFocus disabled={removing} onClick={closeDelete}>Cancel</button>
      <button type="button" className="btn btn-danger" disabled={removing} onClick={deleteReminder}>{removing ? 'Deleting…' : 'Delete reminder'}</button>
    </>}>
      <div className="stack">
        <p><strong>{deleting.name}</strong> will be removed from Settings and stop sending future reminders.</p>
        <ErrorBox error={deleteError} />
      </div>
    </Modal>}
  </>;
}

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail as MailIcon, Search, Paperclip, Send, Check, RotateCcw, ListPlus, Plug, RefreshCw, Inbox, ShieldCheck, Undo2 } from 'lucide-react';
import { api, useApi, useAuth, useToast, fmtTime } from '../lib.jsx';
import { Avatar, Badge, Empty, ErrorBox, Field, Modal, PageHead, Skeleton } from '../ui.jsx';

const nameOf = (from = '') => from.replace(/<.*>/, '').replace(/"/g, '').trim() || from;
const VIEWS = [['open', 'Open'], ['mine', 'Assigned to me'], ['untagged', 'Needs tag'], ['done', 'Done']];

export function Mail() {
  const { can } = useAuth();
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState('inbox');
  useEffect(() => { const t = setTimeout(() => setSearch(q), 300); return () => clearTimeout(t); }, [q]);
  const threads = useApi(`/mail/threads?view=${view}&q=${encodeURIComponent(search)}`, [view, search]);
  const reviews = useApi('/mail/reviews');
  const pending = reviews.data?.length || 0;
  const reload = () => { threads.reload(); reviews.reload(); };

  return (
    <>
      <PageHead title="Mail" subtitle="Email for your clients. Everyone with access to a client can handle it. Staff replies go to the TL for review.">
        {can.manage && <Link className="btn btn-outline" to="/mail/inboxes"><Plug size={16} />Inboxes</Link>}
      </PageHead>
      {(can.manage || pending > 0) && (
        <div className="chips" style={{ marginBottom: 16 }}>
          <button className={`chip ${tab === 'inbox' ? 'on' : ''}`} onClick={() => setTab('inbox')}><Inbox size={16} />Conversations</button>
          <button className={`chip ${tab === 'review' ? 'on' : ''}`} onClick={() => setTab('review')}><ShieldCheck size={16} />To review{pending > 0 && <Badge cls="b-warning">{pending}</Badge>}</button>
        </div>
      )}
      {tab === 'review' ? <Reviews rows={reviews.data} loading={reviews.loading} onChanged={reload} /> : (
        <div className="mail-grid">
          <div className="stack">
            <div className="search"><Search size={16} /><input className="input" placeholder="Search subject or sender" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search email" /></div>
            <div className="chips">{VIEWS.map(([k, l]) => <button key={k} className={`chip ${view === k ? 'on' : ''}`} onClick={() => setView(k)}>{l}</button>)}</div>
            <div className="card list mail-list">
              {threads.loading && !threads.data ? <Skeleton /> : <ErrorBox error={threads.error} />}
              {threads.data?.length === 0 && <Empty icon={MailIcon} title="No conversations here" />}
              {threads.data?.map((t) => (
                <button key={t._id} className={`list-item mail-item ${openId === t._id ? 'on' : ''}`} onClick={() => setOpenId(t._id)}>
                  <div className="li-main">
                    <div className="title">{t.subject}</div>
                    <div className="li-meta"><span>{t.client?.name || 'Not tagged'}</span>{t.assignee && <><span>·</span><span>{t.assignee.name}</span></>}<span>·</span><span>{fmtTime(t.lastMessageAt)}</span></div>
                    <div className="small muted" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.snippet}</div>
                  </div>
                  {!t.client && <Badge cls="b-warning">Tag</Badge>}
                  {t.pendingReplies > 0 && <Badge cls="b-info">In review</Badge>}
                </button>
              ))}
            </div>
          </div>
          {openId ? <Thread key={openId} id={openId} onChanged={reload} /> : <div className="card"><Empty icon={MailIcon} title="Choose a conversation" /></div>}
        </div>
      )}
    </>
  );
}

function Thread({ id, onChanged }) {
  const { data: t, error, reload } = useApi(`/mail/threads/${id}`, [id]);
  const clients = useApi('/clients');
  const users = useApi('/users');
  const toast = useToast();
  const { user } = useAuth();
  const [comment, setComment] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => { reload(); onChanged(); };
  const run = async (fn, done) => {
    setBusy(true);
    try { const res = await fn(); if (done) toast(typeof done === 'function' ? done(res) : done); refresh(); return true; } catch (e) { toast(e.message); return false; } finally { setBusy(false); }
  };
  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!t) return <div className="card"><Skeleton rows={5} /></div>;
  const patch = (b, done) => run(() => api(`/mail/threads/${id}`, { method: 'PATCH', body: b }), done);
  const reply = async () => {
    const ok = await run(() => api(`/mail/threads/${id}/replies`, { method: 'POST', body: { body } }), (r) => (r.status === 'sent' ? 'Reply sent' : 'Sent to your TL for review'));
    if (ok) setBody('');
  };
  const people = (users.data || []).filter((u) => u.active && u.role !== 'super_admin');

  return (
    <div className="card" style={{ overflow: 'hidden', minWidth: 0 }}>
      <div className="card-pad stack" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="row-wrap"><h2 style={{ flex: 1, minWidth: 200 }}>{t.subject}</h2>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => patch({ status: t.status === 'done' ? 'open' : 'done' })}>{t.status === 'done' ? <><RotateCcw size={14} />Reopen</> : <><Check size={14} />Mark done</>}</button>
          <button className="btn btn-outline btn-sm" disabled={busy || !t.client} onClick={() => run(() => api(`/mail/threads/${id}/task`, { method: 'POST', body: {} }), 'Task created and added to your work')}><ListPlus size={14} />Make task</button>
        </div>
        <p className="small muted">Inbox: {t.account?.email}</p>
        <div className="grid grid-2">
          <Field label={t.tagSource === 'auto' ? 'Client (tagged automatically)' : 'Client'}>
            <select className="select" value={t.client?._id || ''} disabled={busy} onChange={(e) => e.target.value && patch({ client: e.target.value }, 'Tagged')}>
              <option value="">Choose client…</option>
              {(clients.data || []).map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Assigned to">
            <select className="select" value={t.assignee?._id || ''} disabled={busy || !t.client} onChange={(e) => patch({ assignee: e.target.value || null })}>
              <option value="">Nobody</option>
              {people.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        {t.tasks.length > 0 && <div className="row-wrap small"><span className="muted">Tasks:</span>{t.tasks.map((k) => <Badge key={k._id} cls={k.status === 'done' ? 'b-success' : ''}>{k.title}</Badge>)}</div>}
      </div>

      {t.messages.map((m) => (
        <article key={m._id} className={`mail-msg ${m.direction === 'out' ? 'out' : ''}`}>
          <div className="row"><Avatar name={nameOf(m.from)} size="sm" /><strong>{nameOf(m.from)}</strong><div className="spacer" /><span className="small muted">{fmtTime(m.date)}</span></div>
          <div className="small muted" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>To: {m.to}</div>
          <div className="mail-text">{m.text || '(no text)'}</div>
          {m.attachments?.length > 0 && <div className="row-wrap small" style={{ marginTop: 10 }}>{m.attachments.map((a, i) => <Badge key={i}><Paperclip size={12} />{a.filename}</Badge>)}</div>}
        </article>
      ))}

      {t.replies.map((r) => <ReplyCard key={r._id} reply={r} mine={String(r.author?._id) === String(user._id)} onChanged={refresh} />)}

      <div className="card-pad stack">
        <Field label={t.canReview ? `Reply to ${nameOf(t.replyTo || '')}` : `Reply to ${nameOf(t.replyTo || '')} (your TL reviews it before it sends)`}>
          <textarea id="mail-reply" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} disabled={!t.client} placeholder={t.client ? 'Write your reply…' : 'Tag a client first'} />
        </Field>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !body.trim() || !t.client} onClick={reply}><Send size={16} />{t.canReview ? 'Send' : 'Send for review'}</button>

        <div className="section-title" style={{ marginBottom: 0 }}>Internal comments (the client never sees these)</div>
        {t.comments.map((c) => <div key={c._id} className="timeline-item"><Avatar name={c.author?.name || '?'} size="sm" /><div><strong>{c.author?.name}</strong> {c.text}<div className="small muted">{fmtTime(c.createdAt)}</div></div></div>)}
        <div className="row"><input id="mail-comment" className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment for the team" aria-label="Comment" />
          <button className="btn btn-tonal" disabled={busy || !comment.trim()} onClick={async () => { if (await run(() => api(`/mail/threads/${id}/comments`, { method: 'POST', body: { text: comment } }))) setComment(''); }}>Add</button></div>
      </div>
    </div>
  );
}

const REPLY_STATE = { pending: ['Waiting for review', 'b-warning'], sent_back: ['Sent back', 'b-danger'], failed: ['Could not send', 'b-danger'], sending: ['Sending', 'b-info'] };

function ReplyCard({ reply, mine, onChanged }) {
  const toast = useToast();
  const [body, setBody] = useState(reply.body);
  const [label, cls] = REPLY_STATE[reply.status] || [reply.status, ''];
  const resubmit = async () => {
    try { await api(`/mail/replies/${reply._id}`, { method: 'PATCH', body: { body } }); toast('Sent for review again'); onChanged(); } catch (e) { toast(e.message); }
  };
  return (
    <article className="mail-msg out">
      <div className="row"><strong>Draft by {reply.author?.name}</strong><div className="spacer" /><Badge cls={cls}>{label}</Badge></div>
      {reply.reviewNote && <div className="form-note" style={{ marginTop: 8 }}>{reply.reviewedBy?.name}: {reply.reviewNote}</div>}
      {reply.error && <div className="form-error" style={{ marginTop: 8 }}>{reply.error}</div>}
      {reply.status === 'sent_back' && mine ? (
        <div className="stack" style={{ marginTop: 10 }}>
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Edit reply" />
          <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={resubmit}><Send size={14} />Send for review again</button>
        </div>
      ) : <div className="mail-text">{reply.body}</div>}
    </article>
  );
}

function Reviews({ rows, loading, onChanged }) {
  if (loading && !rows) return <div className="card"><Skeleton /></div>;
  if (!rows?.length) return <div className="card"><Empty icon={ShieldCheck} title="Nothing to review" /></div>;
  return <div className="stack">{rows.map((r) => <ReviewCard key={r._id} reply={r} onChanged={onChanged} />)}</div>;
}

function ReviewCard({ reply, onChanged }) {
  const toast = useToast();
  const [body, setBody] = useState(reply.body);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (path, payload, done) => {
    setBusy(true);
    try { await api(`/mail/replies/${reply._id}/${path}`, { method: 'POST', body: payload }); toast(done); onChanged(); } catch (e) { toast(e.message); onChanged(); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad stack">
      <div className="row-wrap"><h3 style={{ flex: 1 }}>{reply.thread?.subject}</h3><Badge>{reply.client?.name}</Badge></div>
      <p className="small muted">Written by {reply.author?.name} · To {reply.to}</p>
      {reply.error && <div className="form-error">Last attempt failed: {reply.error}</div>}
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Reply text" />
      <div className="row-wrap">
        <input className="input" style={{ flex: 1, minWidth: 200 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should they change?" aria-label="Note for the writer" />
        {reply.status === 'pending' && <button className="btn btn-outline" disabled={busy || !note.trim()} onClick={() => act('send-back', { note }, 'Sent back')}><Undo2 size={16} />Send back</button>}
        <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={() => act('approve', { body }, 'Approved and sent')}><Check size={16} />Approve and send</button>
      </div>
    </div>
  );
}

/* ---------- Connecting inboxes ---------- */

export function MailInboxes() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi('/mail/accounts');
  const teams = useApi('/teams');
  const toast = useToast();
  const [params] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [team, setTeam] = useState('');
  const notice = params.get('connected') ? `Connected ${params.get('connected')}. Email is being read now.` : null;

  const call = async (fn, done) => { try { await fn(); if (done) toast(done); reload(); } catch (e) { toast(e.message); } };
  const connect = async () => {
    try { const { url } = await api('/mail/accounts/connect', { method: 'POST', body: { team } }); window.location.href = url; } catch (e) { toast(e.message); }
  };
  return (
    <>
      <PageHead title="Inboxes" subtitle="Gmail inboxes connected to the app. Untagged email is visible to the Owner and the inbox team’s TL.">
        {can.super && <button className="btn btn-primary" onClick={() => setConnecting(true)}><Plug size={16} />Connect Gmail inbox</button>}
      </PageHead>
      {notice && <div className="form-note" style={{ marginBottom: 16 }}>{notice}</div>}
      {params.get('error') && <div className="form-error" style={{ marginBottom: 16 }}>{params.get('error')}</div>}
      {data && !data.configured && <div className="form-note" style={{ marginBottom: 16 }}>Google isn’t set up yet. Add the Google details to server/.env and restart the server.</div>}
      <ErrorBox error={error} />
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading && !data ? <Skeleton rows={2} /> : !data?.accounts.length ? <Empty icon={Inbox} title="No inboxes connected" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Inbox</th><th>Team</th><th>Status</th><th>Last read</th><th /></tr></thead>
            <tbody>{data.accounts.map((a) => (
              <tr key={a._id}>
                <td><strong>{a.email}</strong>{a.lastError && <div className="small" style={{ color: 'var(--danger)' }}>{a.lastError}</div>}</td>
                <td>{can.super ? (
                  <select className="select" style={{ minHeight: 36, width: 'auto' }} value={a.team?._id || ''} aria-label={`Team for ${a.email}`} onChange={(e) => call(() => api(`/mail/accounts/${a._id}`, { method: 'PATCH', body: { team: e.target.value } }), 'Saved')}>
                    <option value="">No team</option>{(teams.data || []).map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                  </select>
                ) : a.team?.name}</td>
                <td><Badge cls={a.status === 'active' ? 'b-success' : a.status === 'error' ? 'b-danger' : ''} dot>{a.status}</Badge></td>
                <td className="small muted">{a.lastSyncAt ? fmtTime(a.lastSyncAt) : 'Not yet'}</td>
                <td style={{ textAlign: 'right' }}>{can.super && a.status !== 'disconnected' && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-outline btn-sm" onClick={() => call(() => api(`/mail/accounts/${a._id}/sync`, { method: 'POST' }), 'Inbox checked')}><RefreshCw size={14} />Check now</button>
                  <button className="btn btn-danger btn-sm" onClick={() => call(() => api(`/mail/accounts/${a._id}`, { method: 'DELETE' }), 'Disconnected')}>Disconnect</button>
                </div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {connecting && (
        <Modal title="Connect a Gmail inbox" onClose={() => setConnecting(false)} footer={<><button className="btn btn-ghost" onClick={() => setConnecting(false)}>Cancel</button><button className="btn btn-primary" onClick={connect}>Continue to Google</button></>}>
          <Field label="Team that handles this inbox"><select className="select" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">No team</option>{(teams.data || []).map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}</select></Field>
          <div className="form-note">The app reads this inbox’s last 30 days and new email, and can send replies from it. It cannot delete or change email in Gmail.</div>
        </Modal>
      )}
    </>
  );
}

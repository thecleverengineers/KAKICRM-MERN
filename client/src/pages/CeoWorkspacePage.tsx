import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, FileText, LockKeyhole, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { ceoDate, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

export function CeoWorkspacePage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.workspace');
  const [editing, setEditing] = useState<PublicRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['ceo-notes'], enabled: allowed, queryFn: () => api<Paginated<PublicRecord>>('/ceo/workspace/notes?limit=50') });
  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Opening your confidential workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const notes = query.data.data;
  const saveNote = async (values: { title: string; body: string; tags: string[] }) => {
    setBusy(true); setError(null);
    try {
      if (editing?.legacyId) await api(`/ceo/workspace/notes/${editing.legacyId}`, { method: 'PATCH', body: JSON.stringify(values) });
      else await api('/ceo/workspace/notes', { method: 'POST', body: JSON.stringify(values) });
      setEditing(null); setCreating(false); await queryClient.invalidateQueries({ queryKey: ['ceo-notes'] });
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save the executive note.'); }
    finally { setBusy(false); }
  };
  const removeNote = async (note: PublicRecord) => {
    if (!note.legacyId || !window.confirm('Archive this private CEO note? It can be restored from the data archive.')) return;
    setBusy(true); setError(null);
    try { await api(`/ceo/workspace/notes/${note.legacyId}`, { method: 'DELETE' }); await queryClient.invalidateQueries({ queryKey: ['ceo-notes'] }); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not archive the executive note.'); }
    finally { setBusy(false); }
  };
  return <>
    <PageHeader eyebrow="CONFIDENTIAL EXECUTIVE AREA" title="CEO workspace" description="Private strategy notes, board preparation, goals, risks and forecasts. Notes here are not visible to employees or ordinary HR users." actions={<><button className="button button--secondary" onClick={() => navigate('/ceo-dashboard')}><ArrowLeft size={16} /> Dashboard</button><button className="button" onClick={() => { setEditing(null); setCreating(true); }}><Plus size={16} /> New private note</button></>} />
    <section className="ceo-private-banner"><span><LockKeyhole size={23} /></span><div><strong>CEO-only information</strong><p>Every create, edit and archive action is recorded. Sharing is not enabled by default, and authentication secrets never appear here.</p></div><ShieldCheck size={20} /></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="ceo-workspace-grid"><article className="content-card ceo-workspace-notes"><div className="card-heading"><div><p className="eyebrow">PRIVATE NOTES</p><h2>Strategy and decisions</h2></div><span className="ceo-data-stamp">{notes.length} visible</span></div><div className="ceo-note-list">{notes.map((note) => <article className="ceo-note-card" key={note.id}><div className="ceo-note-card__head"><span className="ceo-note-icon"><FileText size={16} /></span><div><h3>{String(note.fields.title ?? 'Untitled note')}</h3><small>Updated {ceoDate(note.updatedAt)}</small></div><span className="ceo-note-actions"><button className="icon-button icon-button--small" onClick={() => { setEditing(note); setCreating(true); }} aria-label="Edit note"><Pencil size={15} /></button><button className="icon-button icon-button--small danger" onClick={() => void removeNote(note)} aria-label="Archive note" disabled={busy}><Trash2 size={15} /></button></span></div><p>{String(note.fields.body ?? '')}</p>{Array.isArray(note.fields.tags) && <div className="ceo-note-tags">{(note.fields.tags as unknown[]).map((tag) => <span key={String(tag)}>{String(tag)}</span>)}</div>}</article>)}{!notes.length && <div className="ceo-empty-state"><FileText size={28} /><strong>Your private workspace is empty</strong><span>Capture a board note, decision, goal or risk to keep it in one secure place.</span></div>}</div></article><aside className="ceo-workspace-links"><article className="content-card"><p className="eyebrow">EXECUTIVE PLANNING</p><h2>Goals, risks and forecasts</h2><p>Use the company-wide record workspaces for OKRs, risk register and best/expected/worst-case scenarios.</p><button className="ceo-workspace-link" onClick={() => navigate('/data/ceo_goals')}><span>Company goals & OKRs</span><ArrowLeft size={15} /></button><button className="ceo-workspace-link" onClick={() => navigate('/data/ceo_risks')}><span>Risk register</span><ArrowLeft size={15} /></button><button className="ceo-workspace-link" onClick={() => navigate('/data/ceo_forecasts')}><span>Scenario forecasts</span><ArrowLeft size={15} /></button></article><article className="content-card"><p className="eyebrow">SECURITY</p><h2>Audit trail</h2><p>Approval, threshold and private-note actions are retained for executive review.</p><button className="button button--secondary" onClick={() => navigate('/data/ceo_audit_logs')}><Archive size={15} /> Open CEO audit records</button></article></aside></section>
    {creating && <NoteDialog note={editing} busy={busy} onClose={() => { setCreating(false); setEditing(null); }} onSubmit={saveNote} />}
  </>;
}

function NoteDialog({ note, busy, onClose, onSubmit }: { note: PublicRecord | null; busy: boolean; onClose: () => void; onSubmit: (values: { title: string; body: string; tags: string[] }) => Promise<void> }) {
  const [title, setTitle] = useState(String(note?.fields.title ?? ''));
  const [body, setBody] = useState(String(note?.fields.body ?? ''));
  const [tags, setTags] = useState(Array.isArray(note?.fields.tags) ? (note?.fields.tags as unknown[]).map(String).join(', ') : '');
  return <div className="modal-backdrop" role="presentation"><section className="modal ceo-note-modal" role="dialog" aria-modal="true" aria-label={note ? 'Edit executive note' : 'Create executive note'}><div className="modal-header"><div><p className="eyebrow">PRIVATE NOTE</p><h2>{note ? 'Edit executive note' : 'New executive note'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><div className="form-grid"><label className="field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label><label className="field"><span>Note</span><textarea rows={9} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Board context, strategy, decision or risk…" /></label><label className="field"><span>Tags (comma separated)</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="strategy, board, Q4" /></label></div><div className="modal-actions"><button className="button button--secondary" onClick={onClose}>Cancel</button><button className="button" disabled={busy || !title.trim() || !body.trim()} onClick={() => void onSubmit({ title: title.trim(), body: body.trim(), tags: tags.split(',').map((value) => value.trim()).filter(Boolean) })}>{busy ? 'Saving…' : 'Save private note'}</button></div></section></div>;
}

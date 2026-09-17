import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCircle2, ClipboardCheck, MessageCircle, RotateCcw, Send, ShieldAlert, X } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { ceoDate, formatCeoCurrency, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

export function CeoApprovalsPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.approvals.view');
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['ceo-approvals', status, page], enabled: allowed, queryFn: () => api<Paginated<PublicRecord>>(`/ceo/approvals${queryString({ status: status === 'all' ? undefined : status, page, limit: 10 })}`) });
  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Loading CEO approvals…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const result = query.data;
  const act = async (record: PublicRecord, action: 'approve' | 'reject' | 'return' | 'clarify' | 'delegate') => {
    const id = record.legacyId;
    if (!id || busyId) return;
    if (action === 'approve' && !window.confirm('Approve this request? The decision will be recorded in the CEO audit log.')) return;
    const reason = action === 'approve' ? null : window.prompt(action === 'delegate' ? 'Enter the delegate user ID and reason (for example: 42 — Finance review).' : `Enter a reason for ${action === 'return' ? 'returning' : action === 'clarify' ? 'requesting clarification on' : 'rejecting'} this request.`);
    if (reason === null) return;
    let delegatedTo: number | undefined;
    let finalReason = reason.trim();
    if (action === 'delegate') {
      const match = reason.match(/^\s*(\d+)\s*(?:[-:]|\s)\s*(.*)$/);
      if (!match) { setError('Delegation requires a user ID followed by a reason.'); return; }
      delegatedTo = Number(match[1]);
      finalReason = match[2].trim();
      if (!finalReason) { setError('Delegation requires a reason.'); return; }
    }
    setBusyId(id);
    setError(null);
    try {
      await api(`/ceo/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ action, reason: finalReason || null, delegated_to: delegatedTo }) });
      await queryClient.invalidateQueries({ queryKey: ['ceo-approvals'] });
      await queryClient.invalidateQueries({ queryKey: ['ceo-summary'] });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not update the approval.');
    } finally {
      setBusyId(null);
    }
  };
  return <>
    <PageHeader eyebrow="EXECUTIVE CONTROL" title="CEO Approval Centre" description="Review high-value expenses, projects, payroll, discounts, hiring and sensitive decisions with an auditable response." actions={<button className="button button--secondary" onClick={() => navigate('/ceo-dashboard')}><ArrowLeft size={16} /> Dashboard</button>} />
    <section className="ceo-approval-toolbar content-card"><div className="ceo-approval-toolbar__copy"><ClipboardCheck size={22} /><div><strong>{result.pagination.total} request{result.pagination.total === 1 ? '' : 's'}</strong><span>Each decision records who acted, when, and why.</span></div></div><label className="field"><span>Show</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="returned">Returned</option><option value="clarification_requested">Clarification requested</option><option value="delegated">Delegated</option><option value="all">All requests</option></select></label></section>
    {error && <p className="form-error ceo-inline-error" role="alert">{error}</p>}
    <section className="ceo-approval-stack">{result.data.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={busyId === approval.legacyId} onAction={(action) => void act(approval, action)} />)}{!result.data.length && <div className="content-card ceo-empty-state"><CheckCircle2 size={28} /><strong>No {status === 'all' ? '' : status.replaceAll('_', ' ')} approval requests</strong><span>New requests raised from financial, project and people workflows will appear here.</span></div>}</section>
    <div className="pagination"><span>{result.pagination.total} total request{result.pagination.total === 1 ? '' : 's'}</span><div><button className="icon-button icon-button--small" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="Previous approval page">‹</button><span>Page {result.pagination.page} of {result.pagination.pages}</span><button className="icon-button icon-button--small" disabled={page >= result.pagination.pages} onClick={() => setPage((current) => Math.min(result.pagination.pages, current + 1))} aria-label="Next approval page">›</button></div></div>
  </>;
}

function ApprovalCard({ approval, busy, onAction }: { approval: PublicRecord; busy: boolean; onAction: (action: 'approve' | 'reject' | 'return' | 'clarify' | 'delegate') => void }) {
  const fields = approval.fields;
  const history = Array.isArray(fields.approval_history) ? fields.approval_history as Array<Record<string, unknown>> : [];
  const pending = String(fields.status ?? 'pending') === 'pending';
  return <article className={`content-card ceo-approval-card${pending ? ' ceo-approval-card--pending' : ''}`}>
    <div className="ceo-approval-card__head"><span className="ceo-approval-type"><ShieldAlert size={15} /> {String(fields.type ?? 'Executive request')}</span><StatusPill value={fields.status ?? 'pending'} /><span className="ceo-approval-date">Submitted {ceoDate(approval.createdAt)}</span></div>
    <div className="ceo-approval-card__body"><div><h2>{String(fields.title ?? 'Untitled approval')}</h2><p>{String(fields.description ?? 'No description provided.')}</p></div>{fields.amount !== null && fields.amount !== undefined && fields.amount !== '' && <strong className="ceo-approval-amount">{formatCeoCurrency(fields.amount)}</strong>}</div>
    <div className="ceo-approval-card__meta"><span>Requested by <b>#{String(fields.requested_by ?? '—')}</b></span>{Boolean(fields.delegated_to) && <span>Delegated to <b>#{String(fields.delegated_to)}</b></span>}{Boolean(fields.decision_reason) && <span>Reason <b>{String(fields.decision_reason)}</b></span>}</div>
    {history.length > 0 && <details className="ceo-approval-history"><summary>View approval history ({history.length})</summary><div>{history.slice().reverse().map((event, index) => <p key={`${String(event.at)}-${index}`}><strong>{String(event.action ?? 'update')}</strong> by {String(event.by_name ?? `#${event.by ?? '—'}`)} · {ceoDate(event.at)}{event.reason ? ` — ${String(event.reason)}` : ''}</p>)}</div></details>}
    {pending && <div className="ceo-approval-actions"><button className="button ceo-approve-button" type="button" disabled={busy} onClick={() => onAction('approve')}><Check size={15} /> Approve</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => onAction('reject')}><X size={15} /> Reject</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => onAction('return')}><RotateCcw size={15} /> Return</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => onAction('clarify')}><MessageCircle size={15} /> Clarify</button><button className="button button--secondary" type="button" disabled={busy} onClick={() => onAction('delegate')}><Send size={15} /> Delegate</button></div>}
  </article>;
}

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ClipboardCheck, Download, FileText, MessageSquareText, Paperclip } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, apiUrl, getAccessToken, type PublicRecord } from '../lib/api.js';
import { date, dateTime, displayValue } from '../lib/format.js';
import { canManageLeaveAccess } from '../lib/leaveAccess.js';
import { useAuth } from '../store/auth.js';

interface LeaveDetailResponse {
  data: PublicRecord;
}

interface LeaveProof {
  legacyId: number | null;
  name: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

export function LeaveDetailPage() {
  const { leaveId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [reviewNote, setReviewNote] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const canManage = canManageLeaveAccess(user?.role, user?.permissions);
  const backToLeave = () => navigate(searchParams.get('view') === 'manage' ? '/leave?view=manage' : '/leave');
  const query = useQuery({
    queryKey: ['leave-request', leaveId],
    enabled: Boolean(leaveId),
    queryFn: () => api<LeaveDetailResponse>(`/leave/${leaveId}`)
  });
  const filesQuery = useQuery({
    queryKey: ['leave-proof-files', leaveId],
    enabled: Boolean(leaveId),
    queryFn: () => api<{ data: LeaveProof[] }>(`/leave/${leaveId}/files`)
  });

  if (query.isPending) return <LoadingState label="Loading leave request…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const leave = query.data.data;
  const leaveType = displayValue(leave.fields.leave_type).replaceAll('_', ' ');
  const reviewer = displayValue(leave.relationLabels?.reviewed_by ?? leave.fields.reviewed_by);
  const employee = displayValue(leave.relationLabels?.user_id ?? leave.fields.user_id);
  const review = async (status: 'approved' | 'rejected') => {
    if (!leaveId) return;
    setReviewing(true);
    setReviewError(null);
    try {
      await api(`/leave/${leaveId}/review`, { method: 'PATCH', body: JSON.stringify({ status, note: reviewNote.trim() || null }) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-request', leaveId] }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
      ]);
    } catch (problem) {
      setReviewError(problem instanceof Error ? problem.message : 'Could not save the leave decision.');
    } finally {
      setReviewing(false);
    }
  };
  const downloadProof = async (file: LeaveProof) => {
    if (!leaveId || !file.legacyId) return;
    setProofError(null);
    try {
      const token = getAccessToken();
      const response = await fetch(apiUrl(`/leave/${encodeURIComponent(leaveId)}/files/${file.legacyId}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!response.ok) throw new Error('The proof document could not be downloaded.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name || 'leave-proof';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      setProofError(problem instanceof Error ? problem.message : 'The proof document could not be downloaded.');
    }
  };
  return <>
    <PageHeader
      eyebrow="LEAVE REQUEST"
      title={`${leaveType} leave`}
      description={`${canManage ? `${employee} · ` : ''}Request #${leave.legacyId ?? '—'} · submitted ${dateTime(leave.fields.applied_at ?? leave.createdAt)}`}
      actions={<button className="button button--secondary" type="button" onClick={backToLeave}><ArrowLeft size={17} /> Back to leave</button>}
    />
    <section className="leave-detail-grid">
      <article className="content-card record-detail-card">
        <div className="leave-detail-heading"><div><p className="eyebrow">REQUEST SUMMARY</p><h2>Leave schedule and status</h2></div><ClipboardCheck size={20} /></div>
        <dl className="record-detail-list">
          <div><dt>Leave type</dt><dd>{leaveType}</dd></div>
          <div><dt>Status</dt><dd><StatusPill value={leave.fields.status} /></dd></div>
          <div><dt>Start date</dt><dd>{date(leave.fields.start_date)}</dd></div>
          <div><dt>End date</dt><dd>{date(leave.fields.end_date)}</dd></div>
          <div><dt>Days requested</dt><dd>{displayValue(leave.fields.days_count)}</dd></div>
          <div><dt>Applied on</dt><dd>{dateTime(leave.fields.applied_at ?? leave.createdAt)}</dd></div>
          <div><dt>Reviewed by</dt><dd>{reviewer}</dd></div>
          <div><dt>Reviewed on</dt><dd>{dateTime(leave.fields.reviewed_at)}</dd></div>
        </dl>
      </article>
      <aside className="leave-detail-side">
        <article className="content-card leave-detail-note"><div className="leave-detail-heading"><div><p className="eyebrow">REQUEST REASON</p><h2>Why leave was requested</h2></div><FileText size={20} /></div><p>{displayValue(leave.fields.reason)}</p></article>
        <article className="content-card leave-proof-card"><div className="leave-detail-heading"><div><p className="eyebrow">SUPPORTING DOCUMENTS</p><h2>Leave proof</h2></div><Paperclip size={20} /></div>{filesQuery.isPending ? <p className="leave-proof-empty">Loading proof documents…</p> : filesQuery.isError ? <p className="leave-proof-empty">Proof documents could not be loaded.</p> : filesQuery.data.data.length ? <ul className="leave-proof-list">{filesQuery.data.data.map((file) => <li key={file.legacyId}><span><strong>{file.name}</strong><small>{formatFileSize(file.sizeBytes)}</small></span><button className="icon-button icon-button--small" type="button" onClick={() => void downloadProof(file)} aria-label={`Download ${file.name}`} title="Download proof"><Download size={16} /></button></li>)}</ul> : <p className="leave-proof-empty">No proof documents were attached to this request.</p>}{proofError && <p className="form-error" role="alert">{proofError}</p>}</article>
        <article className="content-card leave-detail-note"><div className="leave-detail-heading"><div><p className="eyebrow">REVIEW NOTE</p><h2>Manager response</h2></div><MessageSquareText size={20} /></div><p>{displayValue(leave.fields.review_note)}</p></article>
        {canManage && String(leave.fields.status).toLowerCase() === 'pending' && <article className="content-card leave-detail-review"><div className="leave-detail-heading"><div><p className="eyebrow">MANAGER ACTION</p><h2>Review this request</h2></div><ClipboardCheck size={20} /></div><label className="field"><span>Decision note</span><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={3} maxLength={2000} placeholder="Optional note for the employee" /></label>{reviewError && <p className="form-error" role="alert">{reviewError}</p>}<div className="leave-review-actions"><button className="button button--secondary" type="button" disabled={reviewing} onClick={() => void review('rejected')}>Reject</button><button className="button" type="button" disabled={reviewing} onClick={() => void review('approved')}>{reviewing ? 'Saving…' : 'Approve leave'}</button></div></article>}
        <article className="content-card leave-detail-dates"><CalendarDays size={20} /><span><small>Leave period</small><strong>{date(leave.fields.start_date)} – {date(leave.fields.end_date)}</strong></span></article>
      </aside>
    </section>
  </>;
}

function formatFileSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'File size unavailable';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

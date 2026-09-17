import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ClipboardCheck, FileText, MessageSquareText } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type PublicRecord } from '../lib/api.js';
import { date, dateTime, displayValue } from '../lib/format.js';

interface LeaveDetailResponse {
  data: PublicRecord;
}

export function LeaveDetailPage() {
  const { leaveId } = useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['leave-request', leaveId],
    enabled: Boolean(leaveId),
    queryFn: () => api<LeaveDetailResponse>(`/leave/${leaveId}`)
  });

  if (query.isPending) return <LoadingState label="Loading leave request…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const leave = query.data.data;
  const leaveType = displayValue(leave.fields.leave_type).replaceAll('_', ' ');
  const reviewer = displayValue(leave.relationLabels?.reviewed_by ?? leave.fields.reviewed_by);
  return <>
    <PageHeader
      eyebrow="LEAVE REQUEST"
      title={`${leaveType} leave`}
      description={`Request #${leave.legacyId ?? '—'} · submitted ${dateTime(leave.fields.applied_at ?? leave.createdAt)}`}
      actions={<button className="button button--secondary" type="button" onClick={() => navigate('/leave')}><ArrowLeft size={17} /> Back to leave</button>}
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
        <article className="content-card leave-detail-note"><div className="leave-detail-heading"><div><p className="eyebrow">REVIEW NOTE</p><h2>Manager response</h2></div><MessageSquareText size={20} /></div><p>{displayValue(leave.fields.review_note)}</p></article>
        <article className="content-card leave-detail-dates"><CalendarDays size={20} /><span><small>Leave period</small><strong>{date(leave.fields.start_date)} – {date(leave.fields.end_date)}</strong></span></article>
      </aside>
    </section>
  </>;
}

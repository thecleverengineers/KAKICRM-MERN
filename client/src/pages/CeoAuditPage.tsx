import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { ceoDate, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

export function CeoAuditPage() {
  const { user, hasPermission } = useAuth(); const navigate = useNavigate(); const [page, setPage] = useState(1); const allowed = isCeoRole(user?.role) || hasPermission('ceo.audit.view');
  const query = useQuery({ queryKey: ['ceo-audit', page], enabled: allowed, queryFn: () => api<Paginated<PublicRecord>>(`/ceo/audit?page=${page}&limit=25`) });
  if (!allowed) return <Navigate to="/dashboard" replace />; if (query.isPending) return <LoadingState label="Loading executive audit records…" />; if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const result = query.data;
  return <><PageHeader eyebrow="EXECUTIVE SECURITY" title="CEO Audit Centre" description="Immutable workflow history for approvals, payroll, financial, employee and meeting actions." actions={<button className="button button--secondary" type="button" onClick={() => navigate('/ceo-dashboard')}><ArrowLeft size={16} /> Dashboard</button>} /><section className="ceo-approval-stack">{result.data.map((record) => <article className="content-card ceo-audit-row" key={record.id}><span className="ceo-audit-icon"><ShieldAlert size={16} /></span><div><strong>{String(record.fields.action ?? record.fields.event ?? 'Audit event')}</strong><span>{String(record.fields.collection ?? 'workflow')} · record #{String(record.fields.record_id ?? record.fields.entity_id ?? '—')} · {ceoDate(record.fields.created_at ?? record.createdAt)}</span><p>{String(record.fields.reason ?? record.fields.message ?? 'No reason provided.')}</p></div></article>)}{!result.data.length && <div className="content-card ceo-empty-state"><ShieldAlert size={28} /><strong>No executive audit records</strong><span>Audited CEO actions will appear here.</span></div>}</section>{result.pagination.pages > 1 && <div className="pagination meeting-pagination"><span>Page {result.pagination.page} of {result.pagination.pages}</span><div><button className="icon-button icon-button--small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="icon-button icon-button--small" disabled={page >= result.pagination.pages} onClick={() => setPage((current) => current + 1)} aria-label="Next page"><ChevronRight size={17} /></button></div></div>}</>;
}

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { canManageLeaveAccess } from '../lib/leaveAccess.js';
import { useAuth } from '../store/auth.js';
import '../styles/leave.css';

const leaveResource: ResourceConfig = { id: 'leave_requests', label: 'My Leave', singular: 'Leave request', description: 'Apply for leave, track review status and retain proof files.', icon: CalendarPlus, columns: ['leave_type', 'start_date', 'end_date', 'days_count', 'status', 'review_note'], fields: [] };
const managementResource: ResourceConfig = {
  ...leaveResource,
  label: 'Employee leave requests',
  description: 'Review employee leave requests and their decision history.',
  columns: ['user_id', 'leave_type', 'start_date', 'end_date', 'days_count', 'status'],
  fields: [
    { key: 'user_id', label: 'Employee', kind: 'relation', relation: 'users' },
    { key: 'leave_type', label: 'Leave type' },
    { key: 'start_date', label: 'Start date', kind: 'date' },
    { key: 'end_date', label: 'End date', kind: 'date' },
    { key: 'days_count', label: 'Days' },
    { key: 'status', label: 'Status' }
  ]
};

export function LeavePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManage = canManageLeaveAccess(user?.role, user?.permissions);
  const view = canManage && searchParams.get('view') !== 'mine' ? 'manage' : 'mine';
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('pending');
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['leave-requests', view, page, status],
    queryFn: () => api<Paginated<PublicRecord>>(view === 'manage'
      ? `/leave/manage?page=${page}&limit=15${status === 'all' ? '' : `&status=${encodeURIComponent(status)}`}`
      : `/leave/mine?page=${page}&limit=15`)
  });

  const changeView = (nextView: 'mine' | 'manage') => {
    setPage(1);
    setSearchParams(nextView === 'manage' ? { view: 'manage' } : {});
  };
  const refreshLeave = async () => {
    await queryClient.invalidateQueries({ queryKey: ['leave-requests'] });
    await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
  };

  if (query.isPending) return <LoadingState label={view === 'manage' ? 'Loading employee leave requests…' : 'Loading leave records…'} />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const result = query.data;
  const resource = view === 'manage' ? managementResource : leaveResource;
  return <>
    <PageHeader
      eyebrow={view === 'manage' ? 'PEOPLE OPERATIONS' : 'SELF SERVICE'}
      title={view === 'manage' ? 'Leave management' : 'My leave'}
      description={view === 'manage' ? 'Review company leave requests and record approval decisions.' : 'Submit leave requests and see their approval status in one place.'}
      actions={<button className="button" type="button" onClick={() => setOpen(true)}><CalendarPlus size={17} /> Apply for leave</button>}
    />
    {canManage && <div className="leave-view-switch" role="tablist" aria-label="Leave workspace">
      <button className={`button button--compact ${view === 'manage' ? '' : 'button--secondary'}`} type="button" role="tab" aria-selected={view === 'manage'} onClick={() => changeView('manage')}>Manage requests</button>
      <button className={`button button--compact ${view === 'mine' ? '' : 'button--secondary'}`} type="button" role="tab" aria-selected={view === 'mine'} onClick={() => changeView('mine')}>My requests</button>
    </div>}
    {view === 'manage' && <div className="leave-management-toolbar">
      <label className="field"><span>Request status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="pending">Pending review</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option><option value="all">All requests</option></select></label>
      <span>{result.pagination.total} request{result.pagination.total === 1 ? '' : 's'}</span>
    </div>}
    <DataTable
      records={result.data}
      columns={resource.columns}
      resource={resource}
      page={result.pagination.page}
      pages={result.pagination.pages}
      total={result.pagination.total}
      onPageChange={setPage}
      onOpen={(record) => navigate(`/leave/${record.legacyId}${view === 'manage' ? '?view=manage' : ''}`)}
      clickableRows
      emptyTitle={view === 'manage' ? 'No leave requests in this status' : 'No leave requests yet'}
    />
    <LeaveDialog open={open} onClose={() => setOpen(false)} onApplied={refreshLeave} />
  </>;
}

function LeaveDialog({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: () => Promise<void> }) {
  const [leaveType, setLeaveType] = useState('casual'); const [startDate, setStartDate] = useState(''); const [endDate, setEndDate] = useState(''); const [reason, setReason] = useState(''); const [files, setFiles] = useState<File[]>([]); const [error, setError] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false);
  if (!open) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!files.length) { setError('Attach at least one proof document to continue.'); return; }
    const body = new FormData();
    body.set('leave_type', leaveType);
    body.set('start_date', startDate);
    body.set('end_date', endDate);
    body.set('reason', reason);
    files.forEach((file) => body.append('files', file));
    setSubmitting(true);
    try { await api('/leave/apply', { method: 'POST', body }); await onApplied(); onClose(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not submit the leave request.'); }
    finally { setSubmitting(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">SELF SERVICE</p><h2>Apply for leave</h2></div></div><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field"><span>Leave type</span><select value={leaveType} onChange={(event) => setLeaveType(event.target.value)}><option value="casual">Casual leave</option><option value="sick">Sick leave</option><option value="earned">Earned leave</option><option value="unpaid">Unpaid leave</option></select></label><label className="field"><span>Start date</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label><label className="field"><span>End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label><label className="field field--wide"><span>Reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} required /></label><label className="field field--wide"><span>Proof document <b aria-hidden="true">*</b></span><input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" multiple required onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /><small>Required: attach at least one PDF, JPG, PNG, or WebP file. Up to 10 files, 25 MB each.</small>{files.length > 0 && <small>{files.map((file) => file.name).join(' · ')}</small>}</label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button button--secondary" disabled={submitting} onClick={onClose}>Cancel</button><button className="button" disabled={submitting || files.length === 0}>{submitting ? 'Submitting…' : 'Submit request'}</button></div></form></section></div>;
}

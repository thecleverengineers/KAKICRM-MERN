import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';

const leaveResource: ResourceConfig = { id: 'leave_requests', label: 'My Leave', singular: 'Leave request', description: 'Apply for leave, track review status and retain proof files.', icon: CalendarPlus, columns: ['leave_type', 'start_date', 'end_date', 'days_count', 'status', 'review_note'], fields: [] };

export function LeavePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['my-leave'], queryFn: () => api<Paginated<PublicRecord>>('/leave/mine?limit=100') });
  if (query.isPending) return <LoadingState label="Loading leave records…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  return <><PageHeader eyebrow="SELF SERVICE" title="Leave" description="Submit leave requests and see their approval status in one place." actions={<button className="button" onClick={() => setOpen(true)}><CalendarPlus size={17} /> Apply for leave</button>} /><DataTable records={query.data.data} columns={leaveResource.columns} resource={leaveResource} total={query.data.pagination.total} onOpen={(record) => navigate(`/leave/${record.legacyId}`)} clickableRows /><LeaveDialog open={open} onClose={() => setOpen(false)} onApplied={async () => { await queryClient.invalidateQueries({ queryKey: ['my-leave'] }); }} /></>;
}

function LeaveDialog({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: () => Promise<void> }) {
  const [leaveType, setLeaveType] = useState('casual'); const [startDate, setStartDate] = useState(''); const [endDate, setEndDate] = useState(''); const [reason, setReason] = useState(''); const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); try { await api('/leave/apply', { method: 'POST', body: JSON.stringify({ leave_type: leaveType, start_date: startDate, end_date: endDate, reason }) }); await onApplied(); onClose(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not submit the leave request.'); } };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">SELF SERVICE</p><h2>Apply for leave</h2></div></div><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field"><span>Leave type</span><select value={leaveType} onChange={(event) => setLeaveType(event.target.value)}><option value="casual">Casual leave</option><option value="sick">Sick leave</option><option value="earned">Earned leave</option><option value="unpaid">Unpaid leave</option></select></label><label className="field"><span>Start date</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label><label className="field"><span>End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label><label className="field field--wide"><span>Reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} required /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button className="button">Submit request</button></div></form></section></div>;
}

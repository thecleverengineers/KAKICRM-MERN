import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BellRing,
  BriefcaseBusiness,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  CircleCheck,
  FilePlus2,
  ListTodo,
  LoaderCircle,
  LogIn,
  LogOut,
  Palette,
  Pencil,
  Plus,
  Radar,
  ReceiptText,
  ShieldCheck,
  StickyNote,
  Trash2,
  UsersRound,
  UserRoundCog,
  X
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type PublicRecord } from '../lib/api.js';
import { date, dateTime, displayValue } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface DashboardAction {
  id: string;
  label: string;
  description: string;
  to: string;
  icon: string;
  tone: string;
}

interface Summary {
  metrics: Array<{ key: string; label: string; value: number; tone: string }>;
  quickActions: DashboardAction[];
  myTasks: PublicRecord[];
  myWorkNotes: PublicRecord[];
  notifications: Array<{ legacyId: number; fields: Record<string, unknown>; createdAt: string; updatedAt: string }>;
}

interface AttendanceData {
  date: string;
  shift: PublicRecord | null;
  breaks: PublicRecord[];
}

const WORK_NOTE_COLUMNS = [
  { id: 'pending', label: 'Pending' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' }
] as const;

type WorkNoteStatus = (typeof WORK_NOTE_COLUMNS)[number]['id'];
const WORK_NOTES_PER_PAGE = 5;

interface WorkNoteValues {
  title: string;
  note: string;
  status: WorkNoteStatus;
}

const actionIcons: Record<string, typeof ListTodo> = {
  tasks: ListTodo,
  'task-plus': FilePlus2,
  projects: BriefcaseBusiness,
  teams: UsersRound,
  workforce: Radar,
  'invoice-plus': ReceiptText,
  invoices: ReceiptText,
  leave: CheckSquare,
  people: UserRoundCog,
  branding: Palette
};

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [movingWorkNoteId, setMovingWorkNoteId] = useState<number | null>(null);
  const [deletingWorkNoteId, setDeletingWorkNoteId] = useState<number | null>(null);
  const [workNoteError, setWorkNoteError] = useState<string | null>(null);
  const [workNoteFormOpen, setWorkNoteFormOpen] = useState(false);
  const [editingWorkNote, setEditingWorkNote] = useState<PublicRecord | null>(null);
  const [expandedWorkNoteId, setExpandedWorkNoteId] = useState<number | null>(null);
  const [workNotePages, setWorkNotePages] = useState<Record<WorkNoteStatus, number>>({ pending: 1, active: 1, completed: 1 });
  const query = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => api<Summary>('/dashboard/summary') });
  useEffect(() => {
    const notes = query.data?.myWorkNotes ?? [];
    setWorkNotePages((current) => {
      let next = current;
      for (const column of WORK_NOTE_COLUMNS) {
        const count = notes.filter((note) => workNoteStatus(note.fields.status) === column.id).length;
        const lastPage = Math.max(1, Math.ceil(count / WORK_NOTES_PER_PAGE));
        if (current[column.id] > lastPage) {
          if (next === current) next = { ...current };
          next[column.id] = lastPage;
        }
      }
      return next;
    });
  }, [query.data?.myWorkNotes]);
  if (query.isPending) return <LoadingState label="Preparing your dashboard…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const summary = query.data;

  const refreshWorkNotes = async () => {
    await queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
  };

  const saveWorkNote = async (values: WorkNoteValues) => {
    const body = JSON.stringify(values);
    if (editingWorkNote?.legacyId) {
      await api(`/dashboard/work-notes/${editingWorkNote.legacyId}`, { method: 'PATCH', body });
    } else {
      await api('/dashboard/work-notes', { method: 'POST', body });
    }
    await refreshWorkNotes();
  };

  const moveWorkNote = async (note: PublicRecord, status: WorkNoteStatus) => {
    if (!note.legacyId || workNoteStatus(note.fields.status) === status) return;
    setMovingWorkNoteId(note.legacyId);
    setWorkNoteError(null);
    try {
      await api(`/dashboard/work-notes/${note.legacyId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      if (expandedWorkNoteId === note.legacyId) setExpandedWorkNoteId(null);
      await refreshWorkNotes();
    } catch (problem) {
      setWorkNoteError(problem instanceof Error ? problem.message : 'Could not update the work note status.');
    } finally {
      setMovingWorkNoteId(null);
    }
  };

  const dropped = (event: DragEvent<HTMLElement>, status: WorkNoteStatus) => {
    event.preventDefault();
    const id = Number(event.dataTransfer.getData('text/kaki-work-note-id'));
    const note = summary.myWorkNotes.find((candidate) => candidate.legacyId === id);
    if (note) void moveWorkNote(note, status);
  };

  const deleteWorkNote = async (note: PublicRecord) => {
    if (!note.legacyId || deletingWorkNoteId) return;
    if (!window.confirm('Delete this work note? It will be removed from your dashboard.')) return;
    setDeletingWorkNoteId(note.legacyId);
    setWorkNoteError(null);
    try {
      await api(`/dashboard/work-notes/${note.legacyId}`, { method: 'DELETE' });
      if (editingWorkNote?.legacyId === note.legacyId) {
        setEditingWorkNote(null);
        setWorkNoteFormOpen(false);
      }
      if (expandedWorkNoteId === note.legacyId) setExpandedWorkNoteId(null);
      await refreshWorkNotes();
    } catch (problem) {
      setWorkNoteError(problem instanceof Error ? problem.message : 'Could not delete the work note.');
    } finally {
      setDeletingWorkNoteId(null);
    }
  };

  return <>
    <PageHeader
      eyebrow="YOUR WORKSPACE"
      title={`Good to see you, ${user?.name?.split(' ')[0] ?? 'there'}.`}
      description="Your role-aware shortcuts and personal workflow, live from KAKI CRM."
      actions={hasPermission('attendance.view') ? <button className="button" onClick={() => navigate('/workforce')}><Radar size={17} /> Live workforce</button> : undefined}
    />
    <DashboardShiftControl />
    <section className="metric-grid">
      {summary.metrics.map((metric) => <article key={metric.key} className={`metric-card metric-card--${metric.tone}`}><span>{metric.label}</span><strong>{metric.value}</strong><small>Live from your CRM</small></article>)}
    </section>
    {!!summary.quickActions.length && <section className="dashboard-actions-section">
      <div className="card-heading"><div><p className="eyebrow">QUICK ACTIONS</p><h2>Continue where you need to</h2></div></div>
      <div className="dashboard-actions">
        {summary.quickActions.map((action) => {
          const Icon = actionIcons[action.icon] ?? ShieldCheck;
          return <button key={action.id} className={`dashboard-action dashboard-action--${action.tone}`} onClick={() => navigate(action.to)}>
            <span className="dashboard-action-icon"><Icon size={20} /></span>
            <span><strong>{action.label}</strong><small>{action.description}</small></span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>;
        })}
      </div>
    </section>}
    <section className="dashboard-timeline dashboard-work-notes content-card">
      <div className="card-heading"><div><p className="eyebrow">MY WORK NOTES</p><h2>Keep your own work in focus</h2><p className="muted-copy">Add private work notes for yourself, then move them between pending, active and completed as your day changes.</p></div><button className="button" onClick={() => { setEditingWorkNote(null); setWorkNoteFormOpen(true); }}><Plus size={16} /> Add note</button></div>
      {workNoteError && <p className="form-error">{workNoteError}</p>}
      <div className="dashboard-timeline-board dashboard-work-notes-board">
        {WORK_NOTE_COLUMNS.map((column) => {
          const notes = summary.myWorkNotes.filter((note) => workNoteStatus(note.fields.status) === column.id);
          const totalPages = Math.max(1, Math.ceil(notes.length / WORK_NOTES_PER_PAGE));
          const currentPage = Math.min(workNotePages[column.id], totalPages);
          const firstIndex = (currentPage - 1) * WORK_NOTES_PER_PAGE;
          const visibleNotes = notes.slice(firstIndex, firstIndex + WORK_NOTES_PER_PAGE);
          return <section key={column.id} className={`dashboard-timeline-lane dashboard-timeline-lane--${column.id}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropped(event, column.id)}>
            <header><span>{column.label}</span><b>{notes.length}</b></header>
            <div className="dashboard-timeline-cards">
              {visibleNotes.map((note) => <WorkNoteTimelineCard key={note.id} note={note} expanded={expandedWorkNoteId === note.legacyId} moving={movingWorkNoteId === note.legacyId} deleting={deletingWorkNoteId === note.legacyId} onToggle={() => setExpandedWorkNoteId((current) => current === note.legacyId ? null : note.legacyId ?? null)} onEdit={() => { setEditingWorkNote(note); setWorkNoteFormOpen(true); }} onDelete={() => void deleteWorkNote(note)} onStatusChange={moveWorkNote} />)}
              {!notes.length && <p className="timeline-empty">Drop a note here</p>}
            </div>
            {!!notes.length && <footer className="dashboard-work-note-pagination"><span>{firstIndex + 1}–{Math.min(firstIndex + WORK_NOTES_PER_PAGE, notes.length)} of {notes.length}</span><div><button type="button" className="icon-button" disabled={currentPage === 1} onClick={() => { setExpandedWorkNoteId(null); setWorkNotePages((current) => ({ ...current, [column.id]: Math.max(1, currentPage - 1) })); }} aria-label={`Previous ${column.label.toLowerCase()} notes`}><ChevronLeft size={15} /></button><b>{currentPage} / {totalPages}</b><button type="button" className="icon-button" disabled={currentPage === totalPages} onClick={() => { setExpandedWorkNoteId(null); setWorkNotePages((current) => ({ ...current, [column.id]: Math.min(totalPages, currentPage + 1) })); }} aria-label={`Next ${column.label.toLowerCase()} notes`}><ChevronRight size={15} /></button></div></footer>}
          </section>;
        })}
      </div>
    </section>
    <section className="dashboard-grid">
      <article className="content-card">
        <div className="card-heading"><div><p className="eyebrow">TASK SNAPSHOT</p><h2>What is on your radar</h2></div><button className="text-button" onClick={() => navigate('/tasks')}>All tasks <ArrowRight size={15} /></button></div>
        <div className="activity-list">
          {summary.myTasks.length ? summary.myTasks.slice(0, 6).map((task) => <button className="activity-row activity-row--button" key={task.id} onClick={() => navigate(`/tasks/${task.legacyId}`)}><span className="activity-icon"><CheckSquare size={17} /></span><span className="activity-copy"><strong>{displayValue(task.fields.title)}</strong><small>Due {date(task.fields.due_date)} · {displayValue(task.relationLabels?.assignee_ids ?? task.relationLabels?.assignee_id ?? task.fields.assignee_ids ?? task.fields.assignee_id)}</small></span><StatusPill value={task.fields.status} /></button>) : <p className="muted-copy">No assigned, led or team tasks are open right now.</p>}
        </div>
      </article>
      <article className="content-card">
        <div className="card-heading"><div><p className="eyebrow">INBOX</p><h2>Latest notifications</h2></div><button className="text-button" onClick={() => navigate('/notifications')}>View all <ArrowRight size={15} /></button></div>
        <div className="activity-list">
          {summary.notifications.length ? summary.notifications.map((notification) => <button className="activity-row activity-row--button" key={notification.legacyId} type="button" onClick={() => navigate(notificationDestination(notification))}><span className="activity-icon"><BellRing size={17} /></span><span className="activity-copy"><strong>{displayValue(notification.fields.title)}</strong><small>{displayValue(notification.fields.body)} · {dateTime(notification.createdAt)}</small></span>{!Number(notification.fields.is_read) && <span className="unread-dot" />}</button>) : <p className="muted-copy">You are all caught up.</p>}
        </div>
      </article>
    </section>
    <WorkNoteFormDialog open={workNoteFormOpen} note={editingWorkNote} onClose={() => { setWorkNoteFormOpen(false); setEditingWorkNote(null); }} onSubmit={saveWorkNote} />
  </>;
}

function notificationDestination(record: { fields: Record<string, unknown> }): string {
  const candidate = String(record.fields.url ?? '').trim();
  if (candidate.startsWith('/')) return candidate;
  const taskId = Number(record.fields.task_id ?? record.fields.entity_id);
  return Number.isSafeInteger(taskId) && taskId > 0 ? `/tasks/${taskId}` : '/notifications';
}

function DashboardShiftControl() {
  const queryClient = useQueryClient();
  const attendance = useQuery({ queryKey: ['attendance-me'], queryFn: () => api<AttendanceData>('/attendance/me') });
  const [submitting, setSubmitting] = useState<'start' | 'end' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shiftStarted = Boolean(attendance.data?.shift?.fields.shift_start_ist);
  const shiftEnded = Boolean(attendance.data?.shift?.fields.shift_end_ist);
  const active = shiftStarted && !shiftEnded;

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const activeBreak = Boolean(attendance.data?.breaks.some((entry) => !entry.fields.end_ist));
  const startAt = attendance.data?.shift?.fields.shift_start_ist;
  const endAt = attendance.data?.shift?.fields.shift_end_ist;
  const totalMinutes = Number(attendance.data?.shift?.fields.total_minutes ?? 0);

  const updateShift = async (kind: 'start' | 'end') => {
    setSubmitting(kind);
    setActionError(null);
    try {
      await api(`/attendance/${kind === 'start' ? 'clock-in' : 'clock-out'}`, { method: 'POST', body: JSON.stringify({}) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attendance-me'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['workforce'] })
      ]);
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : `Unable to ${kind === 'start' ? 'start' : 'end'} your shift.`);
    } finally {
      setSubmitting(null);
    }
  };

  const stateCopy = attendance.isPending
    ? { eyebrow: 'TODAY’S ATTENDANCE', title: 'Checking your shift status…', detail: 'Your personal attendance is loading.', icon: <LoaderCircle className="dashboard-shift-spinner" size={23} /> }
    : attendance.isError
      ? { eyebrow: 'TODAY’S ATTENDANCE', title: 'Attendance status unavailable', detail: 'Please refresh the page or open Attendance to try again.', icon: <CalendarClock size={23} /> }
      : active
        ? { eyebrow: 'YOUR WORKDAY IS LIVE', title: 'Shift in progress', detail: `${formatTime(startAt)} · ${formatDuration(startAt, now)} today`, icon: <CalendarClock size={23} /> }
        : shiftEnded
          ? { eyebrow: 'TODAY’S ATTENDANCE', title: 'Shift completed', detail: `${formatTime(endAt)} · ${formatCompletedDuration(totalMinutes)} recorded`, icon: <CircleCheck size={23} /> }
          : { eyebrow: 'TODAY’S ATTENDANCE', title: 'Ready to start your day?', detail: 'Start your shift to appear live to your team and managers.', icon: <CalendarClock size={23} /> };

  return <section className={`dashboard-shift-hero dashboard-shift-hero--${active ? 'active' : shiftEnded ? 'completed' : 'ready'}`} aria-label="Shift controls">
    <div className="dashboard-shift-copy">
      <span className="dashboard-shift-state-icon">{stateCopy.icon}</span>
      <div><p>{stateCopy.eyebrow}</p><h2>{stateCopy.title}</h2><span>{stateCopy.detail}</span></div>
    </div>
    <div className="dashboard-shift-actions">
      <button className="dashboard-shift-action dashboard-shift-action--start" type="button" disabled={attendance.isPending || attendance.isError || shiftStarted || submitting !== null} onClick={() => void updateShift('start')}>
        <span className="dashboard-shift-action-icon">{submitting === 'start' ? <LoaderCircle className="dashboard-shift-spinner" size={22} /> : <LogIn size={22} />}</span>
        <span><strong>Start shift</strong><small>{shiftStarted ? `Started ${formatTime(startAt)}` : 'Begin your workday'}</small></span>
      </button>
      <button className="dashboard-shift-action dashboard-shift-action--end" type="button" disabled={attendance.isPending || attendance.isError || !active || activeBreak || submitting !== null} onClick={() => void updateShift('end')}>
        <span className="dashboard-shift-action-icon">{submitting === 'end' ? <LoaderCircle className="dashboard-shift-spinner" size={22} /> : <LogOut size={22} />}</span>
        <span><strong>End shift</strong><small>{activeBreak ? 'End your active break first' : active ? 'Close today’s workday' : shiftEnded ? 'Shift already completed' : 'Available after starting'}</small></span>
      </button>
    </div>
    {actionError && <p className="dashboard-shift-error" role="alert">{actionError}</p>}
  </section>;
}

function formatTime(value: unknown): string {
  if (!value) return 'just now';
  const parsed = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(parsed.valueOf())) return String(value);
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(parsed);
}

function formatDuration(value: unknown, now: number): string {
  if (!value) return 'Working now';
  const startedAt = new Date(String(value).replace(' ', 'T')).valueOf();
  if (Number.isNaN(startedAt)) return 'Working now';
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  return formatCompletedDuration(minutes);
}

function formatCompletedDuration(minutes: number): string {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (!hours) return `${remainder}m`;
  return `${hours}h${remainder ? ` ${remainder}m` : ''}`;
}

function WorkNoteTimelineCard({ note, expanded, moving, deleting, onToggle, onEdit, onDelete, onStatusChange }: { note: PublicRecord; expanded: boolean; moving: boolean; deleting: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; onStatusChange: (note: PublicRecord, status: WorkNoteStatus) => Promise<void> }) {
  const status = workNoteStatus(note.fields.status);
  const details = String(note.fields.notes ?? note.fields.note ?? '').trim();
  const busy = moving || deleting;
  const detailId = `work-note-details-${note.legacyId}`;
  return <article className={`dashboard-task-card dashboard-work-note-card dashboard-work-note-card--${status} ${expanded ? 'dashboard-work-note-card--expanded' : ''} ${busy ? 'dashboard-task-card--moving' : ''}`} draggable={!busy} onDragStart={(event) => event.dataTransfer.setData('text/kaki-work-note-id', String(note.legacyId))}>
    <button className="dashboard-work-note-summary" type="button" onClick={onToggle} disabled={busy} aria-expanded={expanded} aria-controls={detailId}><span className="dashboard-work-note-icon"><StickyNote size={14} /></span><span className="dashboard-work-note-summary-copy"><strong>{displayValue(note.fields.title)}</strong><small>{status}</small></span><ChevronDown className="dashboard-work-note-chevron" size={16} aria-hidden="true" /></button>
    {expanded && <div id={detailId} className="dashboard-work-note-panel"><p className={details ? 'dashboard-work-note-copy' : 'dashboard-work-note-empty-copy'}>{details || 'No extra details added.'}</p><div className="dashboard-work-note-meta"><span>Updated {dateTime(note.updatedAt)}</span><div><button className="icon-button dashboard-work-note-action" type="button" onClick={onEdit} disabled={busy} aria-label="Edit work note"><Pencil size={14} /></button><button className="icon-button dashboard-work-note-action dashboard-work-note-action--delete" type="button" onClick={onDelete} disabled={busy} aria-label="Delete work note"><Trash2 size={14} /></button></div></div><label className="dashboard-task-select"><span className="sr-only">Update work note status</span><select value={status} disabled={busy} onChange={(event) => void onStatusChange(note, event.target.value as WorkNoteStatus)}><option value="pending">Pending</option><option value="active">Active</option><option value="completed">Completed</option></select></label></div>}
  </article>;
}

function WorkNoteFormDialog({ open, note, onClose, onSubmit }: { open: boolean; note: PublicRecord | null; onClose: () => void; onSubmit: (values: WorkNoteValues) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [status, setStatus] = useState<WorkNoteStatus>('pending');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(String(note?.fields.title ?? ''));
    setDetails(String(note?.fields.notes ?? note?.fields.note ?? ''));
    setStatus(workNoteStatus(note?.fields.status));
    setSaving(false);
    setError(null);
  }, [open, note]);

  if (!open) return null;
  const editing = Boolean(note?.legacyId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ title: title.trim(), note: details.trim(), status });
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save the work note.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose(); }}>
    <section className="modal dashboard-work-note-modal" role="dialog" aria-modal="true" aria-label={editing ? 'Edit work note' : 'Add work note'} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><p className="eyebrow">MY WORK NOTES</p><h2>{editing ? 'Edit work note' : 'Add work note'}</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={19} /></button></div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label className="field field--wide"><span>Note title *</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} required autoFocus placeholder="What do you need to remember?" /></label>
          <label className="field field--wide"><span>Details</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={5_000} rows={5} placeholder="Add any useful context, next step or reminder…" /></label>
          <label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as WorkNoteStatus)}><option value="pending">Pending</option><option value="active">Active</option><option value="completed">Completed</option></select></label>
        </div>
        <p className="dashboard-work-note-form-copy">This note is tied to your account. You can edit, move or delete it anytime.</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add note'}</button></div>
      </form>
    </section>
  </div>;
}

function workNoteStatus(value: unknown): WorkNoteStatus {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'active' || normalized === 'in_progress') return 'active';
  return 'pending';
}

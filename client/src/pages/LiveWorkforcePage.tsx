import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import {
  Activity,
  AlarmClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Coffee,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  UserCheck,
  UserMinus,
  UsersRound,
  X
} from 'lucide-react';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, getAccessToken } from '../lib/api.js';
import { dateTime, initials } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

type AttendanceState = 'working' | 'on_break' | 'completed' | 'half_day' | 'on_leave' | 'present' | 'absent' | 'not_started';

interface WorkforcePerson {
  user: { id: number; name: string; email: string; department: string; designation: string };
  attendance: {
    state: AttendanceState;
    shiftId: number | null;
    checkIn: string | null;
    checkOut: string | null;
    totalMinutes: number;
    breakMinutes: number;
    source: string | null;
  };
  workflow: {
    totalTasks: number;
    openTasks: number;
    completedTasks: number;
    overdueTasks: number;
    activeTaskTitles: string[];
    updatesToday: number;
    lastUpdateAt: string | null;
    dailyCheckin: { plan: string; priorities: string; blockers: string } | null;
  };
  overtime: { status: string; minutes: number } | null;
}

interface WorkforceData {
  date: string;
  generatedAt: string;
  totals: {
    activeEmployees: number;
    checkedIn: number;
    working: number;
    onBreak: number;
    completed: number;
    onLeave: number;
    absent: number;
    activeTasks: number;
    overdueTasks: number;
  };
  people: WorkforcePerson[];
}

const stateFilters: Array<{ value: 'all' | AttendanceState; label: string }> = [
  { value: 'all', label: 'All status' },
  { value: 'working', label: 'Working' },
  { value: 'on_break', label: 'On break' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'not_started', label: 'Not started' },
  { value: 'absent', label: 'Absent' }
];

export function LiveWorkforcePage() {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const [date, setDate] = useState(todayIst());
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'all' | AttendanceState>('all');
  const [department, setDepartment] = useState('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [followUp, setFollowUp] = useState<WorkforcePerson | null>(null);
  const [message, setMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['live-workforce', date],
    queryFn: () => api<WorkforceData>(`/attendance/workforce?date=${encodeURIComponent(date)}`),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true
  });

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return undefined;
    const socket = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    const refresh = (event?: { date?: string }) => {
      if (!event?.date || event.date === date) void queryClient.invalidateQueries({ queryKey: ['live-workforce', date] });
    };
    socket.on('attendance:changed', refresh);
    socket.on('workflow:follow-up', refresh);
    socket.on('workflow:changed', refresh);
    return () => { socket.disconnect(); };
  }, [date, queryClient]);

  const people = query.data?.people ?? [];
  const departments = useMemo(() => [...new Set(people.map((person) => person.user.department))].sort((a, b) => a.localeCompare(b)), [people]);
  const visiblePeople = useMemo(() => people.filter((person) => {
    const value = `${person.user.name} ${person.user.email} ${person.user.department} ${person.user.designation}`.toLowerCase();
    return (!search.trim() || value.includes(search.trim().toLowerCase()))
      && (state === 'all' || person.attendance.state === state)
      && (department === 'all' || person.user.department === department);
  }), [people, search, state, department]);
  const selected = people.find((person) => person.user.id === selectedId) ?? visiblePeople[0] ?? null;
  const canManage = hasPermission('attendance.manage');
  const isToday = date === todayIst();

  const updateAttendance = async (person: WorkforcePerson, action: 'mark_present' | 'mark_absent' | 'end_shift') => {
    const key = `${person.user.id}:${action}`;
    setActionError(null);
    setPendingAction(key);
    try {
      await api(`/attendance/workforce/${person.user.id}/attendance`, {
        method: 'PATCH',
        body: JSON.stringify({ action, date })
      });
      await queryClient.invalidateQueries({ queryKey: ['live-workforce', date] });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The attendance change could not be saved.');
    } finally {
      setPendingAction(null);
    }
  };

  const sendFollowUp = async () => {
    if (!followUp || !message.trim()) return;
    setActionError(null);
    setPendingAction(`follow:${followUp.user.id}`);
    try {
      await api(`/attendance/workforce/${followUp.user.id}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ message: message.trim(), date })
      });
      setFollowUp(null);
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: ['live-workforce', date] });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The workflow follow-up could not be sent.');
    } finally {
      setPendingAction(null);
    }
  };

  if (query.isPending) return <LoadingState label="Loading the live workforce command centre…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const data = query.data;

  return <>
    <PageHeader
      eyebrow="LIVE WORKFORCE COMMAND"
      title="Daily workforce"
      description={`Attendance and workflow signals for ${data.date}. Times are shown in India Standard Time.`}
      actions={<><span className="live-indicator"><span /> Live updates</span><button className="button button--secondary" onClick={() => void query.refetch()}><RefreshCw size={16} /> Refresh</button></>}
    />
    <section className="workforce-hero">
      <div className="workforce-hero-copy"><span className="workforce-hero-icon"><Activity size={23} /></span><div><p>Live command centre</p><h2>{data.totals.working} people are actively working</h2><small>Updated {dateTime(data.generatedAt)} · automatic refresh is on</small></div></div>
      <div className="workforce-hero-stats"><span><strong>{data.totals.activeTasks}</strong> active tasks</span><span><strong>{data.totals.overdueTasks}</strong> overdue tasks</span></div>
    </section>
    <section className="workforce-kpi-grid" aria-label="Workforce summary">
      <Kpi icon={<UsersRound size={19} />} label="Team online" value={`${data.totals.checkedIn}/${data.totals.activeEmployees}`} detail="checked in today" tone="blue" />
      <Kpi icon={<UserCheck size={19} />} label="Working now" value={data.totals.working} detail="currently active" tone="green" />
      <Kpi icon={<Coffee size={19} />} label="On break" value={data.totals.onBreak} detail="live break status" tone="orange" />
      <Kpi icon={<CheckCircle2 size={19} />} label="Shift complete" value={data.totals.completed} detail="finished today" tone="violet" />
      <Kpi icon={<UserMinus size={19} />} label="Away / absent" value={data.totals.absent + data.totals.onLeave} detail={`${data.totals.onLeave} on approved leave`} tone="rose" />
    </section>
    <section className="workforce-toolbar content-card">
      <div className="workforce-toolbar-controls">
        <label className="workforce-date"><span>Work date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee, team or role" aria-label="Search workforce" /></label>
        <select value={state} onChange={(event) => setState(event.target.value as 'all' | AttendanceState)} aria-label="Filter attendance status">
          {stateFilters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <select value={department} onChange={(event) => setDepartment(event.target.value)} aria-label="Filter department"><option value="all">All departments</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select>
      </div>
      <span>{visiblePeople.length} of {people.length} people shown</span>
    </section>
    {actionError && <div className="workforce-alert"><CircleAlert size={17} /><span>{actionError}</span><button className="icon-button" onClick={() => setActionError(null)} aria-label="Dismiss message"><X size={16} /></button></div>}
    <section className="workforce-layout">
      <article className="content-card workforce-list-card">
        <div className="workforce-card-heading"><div><p className="eyebrow">LIVE ROSTER</p><h2>Attendance & daily work</h2></div><span className="soft-count">{visiblePeople.length} people</span></div>
        <div className="workforce-roster">
          {visiblePeople.map((person) => <button key={person.user.id} type="button" onClick={() => setSelectedId(person.user.id)} className={`workforce-row ${selected?.user.id === person.user.id ? 'workforce-row--selected' : ''}`}>
            <span className="workforce-avatar">{initials(person.user.name)}</span>
            <span className="workforce-person"><strong>{person.user.name}</strong><small>{person.user.designation} · {person.user.department}</small></span>
            <span className={`presence-pill presence-pill--${person.attendance.state}`}><i />{stateLabel(person.attendance.state)}</span>
            <span className="workforce-time"><strong>{formatDuration(person.attendance.totalMinutes)}</strong><small>{person.attendance.checkIn ? `In ${shortTime(person.attendance.checkIn)}` : 'No check-in'}</small></span>
            <span className="workforce-work"><strong>{person.workflow.openTasks}/{person.workflow.totalTasks} open</strong><small>{person.workflow.overdueTasks ? `${person.workflow.overdueTasks} overdue` : `${person.workflow.updatesToday} updates today`}</small></span>
            <ChevronRight className="workforce-chevron" size={17} />
          </button>)}
          {!visiblePeople.length && <div className="workforce-empty"><UsersRound size={21} /><strong>No employees match these filters.</strong><span>Try another status, department, or search phrase.</span></div>}
        </div>
      </article>
      <aside className="content-card workforce-detail-card">
        {selected ? <WorkforceDetail person={selected} canManage={canManage} isToday={isToday} pendingAction={pendingAction} onAction={updateAttendance} onFollowUp={(person) => { setFollowUp(person); setMessage(`Hi ${person.user.name.split(' ')[0]}, please share a short update on your priority work for today.`); }} /> : <div className="workforce-empty"><ClipboardList size={21} /><strong>Select an employee</strong><span>Attendance and daily workflow details will appear here.</span></div>}
      </aside>
    </section>
    {followUp && <div className="modal-backdrop" role="presentation" onMouseDown={() => setFollowUp(null)}><section className="modal workforce-followup-modal" role="dialog" aria-modal="true" aria-label="Send workflow follow-up" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><p className="eyebrow">WORKFLOW FOLLOW-UP</p><h2>Message {followUp.user.name}</h2></div><button className="icon-button" onClick={() => setFollowUp(null)} aria-label="Close"><X size={18} /></button></div>
      <p className="muted-copy">The employee will receive this in their CRM notifications.</p>
      <label className="field field--wide"><span>Message</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} rows={5} autoFocus /></label>
      <div className="modal-actions"><button className="button button--secondary" onClick={() => setFollowUp(null)}>Cancel</button><button className="button" disabled={!message.trim() || pendingAction === `follow:${followUp.user.id}`} onClick={() => void sendFollowUp()}><Send size={16} /> {pendingAction === `follow:${followUp.user.id}` ? 'Sending…' : 'Send follow-up'}</button></div>
    </section></div>}
  </>;
}

function Kpi({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string | number; detail: string; tone: string }) {
  return <article className={`workforce-kpi workforce-kpi--${tone}`}><span className="workforce-kpi-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><span>{detail}</span></div></article>;
}

function WorkforceDetail({ person, canManage, isToday, pendingAction, onAction, onFollowUp }: {
  person: WorkforcePerson;
  canManage: boolean;
  isToday: boolean;
  pendingAction: string | null;
  onAction: (person: WorkforcePerson, action: 'mark_present' | 'mark_absent' | 'end_shift') => Promise<void>;
  onFollowUp: (person: WorkforcePerson) => void;
}) {
  const state = person.attendance.state;
  const action = (name: 'mark_present' | 'mark_absent' | 'end_shift', label: string, icon: ReactNode, className = 'button button--secondary') => <button className={className} disabled={pendingAction === `${person.user.id}:${name}`} onClick={() => void onAction(person, name)}>{icon}{pendingAction === `${person.user.id}:${name}` ? 'Saving…' : label}</button>;
  return <>
    <div className="workforce-detail-head"><span className="workforce-avatar workforce-avatar--large">{initials(person.user.name)}</span><div><p className="eyebrow">EMPLOYEE PULSE</p><h2>{person.user.name}</h2><p>{person.user.designation} · {person.user.department}</p></div></div>
    <div className="workforce-detail-presence"><span className={`presence-pill presence-pill--${state}`}><i />{stateLabel(state)}</span><span><AlarmClock size={15} /> {person.attendance.checkIn ? `${formatDuration(person.attendance.totalMinutes)} today` : 'No recorded time'}</span></div>
    <div className="detail-metrics"><div><small>Check-in</small><strong>{shortTime(person.attendance.checkIn)}</strong></div><div><small>Break time</small><strong>{formatDuration(person.attendance.breakMinutes)}</strong></div><div><small>Task updates</small><strong>{person.workflow.updatesToday}</strong></div></div>
    <section className="workflow-panel"><div className="workflow-panel-heading"><div><p className="eyebrow">DAILY WORKFLOW</p><h3>Today’s momentum</h3></div><span className={person.workflow.overdueTasks ? 'workflow-risk' : 'workflow-safe'}>{person.workflow.overdueTasks ? `${person.workflow.overdueTasks} overdue` : 'On track'}</span></div>
      <div className="workflow-progress"><div><span>Open work</span><strong>{person.workflow.openTasks} / {person.workflow.totalTasks}</strong></div><div><span>Completed</span><strong>{person.workflow.completedTasks}</strong></div></div>
      <div className="workflow-task-list">{person.workflow.activeTaskTitles.length ? person.workflow.activeTaskTitles.map((title) => <span key={title}><ClipboardList size={14} />{title}</span>) : <span className="muted-copy">No open assigned task is recorded.</span>}</div>
      {person.workflow.dailyCheckin && <div className="daily-checkin"><strong>Daily check-in</strong>{person.workflow.dailyCheckin.plan && <p>{person.workflow.dailyCheckin.plan}</p>}{person.workflow.dailyCheckin.priorities && <small><b>Priorities:</b> {person.workflow.dailyCheckin.priorities}</small>}{person.workflow.dailyCheckin.blockers && <small className="daily-checkin-blocker"><b>Blockers:</b> {person.workflow.dailyCheckin.blockers}</small>}</div>}
      {!person.workflow.dailyCheckin && <div className="daily-checkin daily-checkin--empty"><strong>No daily check-in yet</strong><p>Use a follow-up to request the employee’s plan or blockers.</p></div>}
    </section>
    {canManage && isToday && <section className="workforce-actions"><p className="eyebrow">MANAGEMENT ACTIONS</p><div>{['working', 'on_break'].includes(state) && action('end_shift', 'End shift', <CheckCircle2 size={16} />, 'button')}{['not_started', 'absent'].includes(state) && action('mark_present', 'Mark present', <UserCheck size={16} />, 'button')}{state === 'not_started' && action('mark_absent', 'Mark absent', <UserMinus size={16} />)}<button className="button button--secondary" onClick={() => onFollowUp(person)}><MessageSquareText size={16} /> Follow up</button></div></section>}
    {canManage && !isToday && <p className="workforce-readonly">Live attendance actions are available for today. You can still review the selected date.</p>}
    {!canManage && <p className="workforce-readonly">You have read-only workforce visibility. Ask an administrator to assign <code>attendance.manage</code> to enable HR actions.</p>}
  </>;
}

function stateLabel(value: AttendanceState): string {
  return ({ working: 'Working', on_break: 'On break', completed: 'Completed', half_day: 'Half day', on_leave: 'On leave', present: 'Present', absent: 'Absent', not_started: 'Not started' })[value];
}

function formatDuration(value: number): string {
  const minutes = Math.max(0, Math.round(value));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function shortTime(value: string | null): string {
  if (!value) return '—';
  const matched = value.match(/(?:\s|T)(\d{2}:\d{2})/);
  return matched?.[1] ?? value;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

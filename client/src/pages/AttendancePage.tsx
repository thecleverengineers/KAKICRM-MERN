import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Coffee, LogIn, LogOut, Save, Timer, Trash2, UserRoundCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type PublicRecord } from '../lib/api.js';
import { dateTime, displayValue } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface OvertimePolicy {
  dayType: 'working_day' | 'weekend' | 'holiday';
  category: 'after_hours' | 'weekend' | 'holiday' | 'manual' | 'none';
  holidayName: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  automaticMinutes: number;
  manualOverrideMinutes: number;
  overtimeMinutes: number;
}
interface AttendanceData { date: string; shift: PublicRecord | null; breaks: PublicRecord[]; overtime: PublicRecord[]; log: PublicRecord | null; overtimePolicy: OvertimePolicy; }
interface AttendanceEmployeeOption { id: number; label: string; department: string | null; designation: string | null; }

const defaultManualAttendance = () => ({ employeeId: '', date: localDate(new Date()), status: 'present', working_hours: '8', break_minutes: '0', overtime_minutes: '0', check_in: '', check_out: '', note: '' });

export function AttendancePage() {
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const query = useQuery({ queryKey: ['attendance-me'], queryFn: () => api<AttendanceData>('/attendance/me') });
  const canManageAttendance = hasPermission('attendance.manage') || hasPermission('employees.manage') || isAdminOrHr(user?.role);
  const employeesQuery = useQuery({ queryKey: ['attendance-manual-employees'], enabled: canManageAttendance, queryFn: () => api<{ data: AttendanceEmployeeOption[] }>('/attendance/employees') });
  const [manual, setManual] = useState(defaultManualAttendance);
  const [holiday, setHoliday] = useState(() => ({ date: localDate(new Date()), name: '', note: '' }));
  const holidaysQuery = useQuery({ queryKey: ['attendance-holidays', holiday.date.slice(0, 4)], enabled: canManageAttendance, queryFn: () => api<{ data: PublicRecord[] }>(`/attendance/holidays?year=${holiday.date.slice(0, 4)}`) });
  const [savingManual, setSavingManual] = useState(false);
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [savingHoliday, setSavingHoliday] = useState(false);
  const [holidayMessage, setHolidayMessage] = useState<string | null>(null);
  const [holidayError, setHolidayError] = useState<string | null>(null);
  if (query.isPending) return <LoadingState label="Loading today’s attendance…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const data = query.data;
  const activeBreak = data.breaks.find((entry) => !entry.fields.end_ist);
  const overtimePolicy = data.overtimePolicy;
  const action = async (path: string) => { const body = path === '/overtime/request' ? { reason: 'Overtime work request' } : {}; await api(`/attendance${path}`, { method: 'POST', body: JSON.stringify(body) }); await queryClient.invalidateQueries({ queryKey: ['attendance-me'] }); };
  const saveManualAttendance = async (event: FormEvent) => {
    event.preventDefault();
    if (!manual.employeeId) {
      setManualError('Select an employee first.');
      return;
    }
    setSavingManual(true);
    setManualError(null);
    setManualMessage(null);
    try {
      await api(`/attendance/manual/${manual.employeeId}`, { method: 'PUT', body: JSON.stringify({
        date: manual.date,
        status: manual.status,
        working_hours: Number(manual.working_hours),
        break_minutes: Number(manual.break_minutes),
        overtime_minutes: Number(manual.overtime_minutes),
        check_in: manual.check_in || null,
        check_out: manual.check_out || null,
        note: manual.note.trim() || null
      }) });
      const employee = employeesQuery.data?.data.find((item) => String(item.id) === manual.employeeId);
      setManualMessage(`Attendance saved for ${employee?.label ?? 'the employee'} on ${manual.date}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attendance-me'] }),
        queryClient.invalidateQueries({ queryKey: ['live-workforce'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-workspace', manual.employeeId] })
      ]);
    } catch (problem) {
      setManualError(problem instanceof Error ? problem.message : 'Unable to save employee attendance.');
    } finally {
      setSavingManual(false);
    }
  };
  const saveHoliday = async (event: FormEvent) => {
    event.preventDefault();
    setSavingHoliday(true);
    setHolidayError(null);
    setHolidayMessage(null);
    try {
      await api('/attendance/holidays', { method: 'POST', body: JSON.stringify({ date: holiday.date, name: holiday.name.trim(), note: holiday.note.trim() || null }) });
      setHolidayMessage(`${holiday.name.trim()} is saved as a holiday.`);
      setHoliday((current) => ({ ...current, name: '', note: '' }));
      await queryClient.invalidateQueries({ queryKey: ['attendance-holidays'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance-me'] });
    } catch (problem) {
      setHolidayError(problem instanceof Error ? problem.message : 'Unable to save the holiday.');
    } finally {
      setSavingHoliday(false);
    }
  };
  const removeHoliday = async (id: string) => {
    if (!window.confirm('Remove this holiday from the overtime calendar?')) return;
    setHolidayError(null);
    setHolidayMessage(null);
    try {
      await api(`/attendance/holidays/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['attendance-holidays'] });
      await queryClient.invalidateQueries({ queryKey: ['attendance-me'] });
    } catch (problem) {
      setHolidayError(problem instanceof Error ? problem.message : 'Unable to remove the holiday.');
    }
  };
  return <>
    <PageHeader eyebrow="SELF SERVICE" title="Attendance" description={`Your workday for ${data.date}. All times use India Standard Time.`} />
    <section className="attendance-hero">
      <div><span className="attendance-icon"><UserRoundCheck size={25} /></span><div><p>Today’s shift</p><h2>{data.shift ? <StatusPill value={data.shift.fields.status} /> : 'Not started'}</h2><small>Started: {dateTime(data.shift?.fields.shift_start_ist)}</small></div></div>
      <div className="attendance-controls">
        {!Boolean(data.shift?.fields.shift_start_ist) && <button className="button" onClick={() => void action('/clock-in')}><LogIn size={17} /> Start shift</button>}
        {Boolean(data.shift?.fields.shift_start_ist) && !Boolean(data.shift?.fields.shift_end_ist) && <><button className="button button--secondary" onClick={() => void action(activeBreak ? '/breaks/end' : '/breaks/start')}><Coffee size={17} /> {activeBreak ? 'End break' : 'Start break'}</button><button className="button" onClick={() => void action('/clock-out')}><LogOut size={17} /> End shift</button></>}
      </div>
    </section>

    <section className="attendance-grid">
      <article className="content-card">
        <div className="card-heading"><div><p className="eyebrow">BREAKS</p><h2>Today’s breaks</h2></div><Coffee size={19} /></div>
        <ul className="simple-list">{data.breaks.map((entry) => <li key={entry.id}><strong>{dateTime(entry.fields.start_ist)}</strong><span>{entry.fields.end_ist ? `${displayValue(entry.fields.minutes)} minutes` : 'In progress'}</span></li>)}{!data.breaks.length && <li className="muted-copy">No breaks taken yet.</li>}</ul>
      </article>
      <article className="content-card">
        <div className="card-heading"><div><p className="eyebrow">OVERTIME</p><h2>Automatic overtime</h2></div><Timer size={19} /></div>
        <p className="muted-copy">{overtimeRuleLabel(overtimePolicy)}</p>
        <p><strong>{duration(overtimePolicy.overtimeMinutes)}</strong> recorded overtime today</p>
        <button className="button button--secondary" onClick={() => void action('/overtime/request')}>Request additional overtime</button>
        <ul className="simple-list">{data.overtime.map((entry) => <li key={entry.id}><strong>{displayValue(entry.fields.category ?? entry.fields.status).replaceAll('_', ' ')}</strong><span>{duration(Number(entry.fields.ot_minutes ?? 0))} · {displayValue(entry.fields.status).replaceAll('_', ' ')}</span></li>)}{!data.overtime.length && <li className="muted-copy">No overtime recorded yet. It will be calculated when the shift ends.</li>}</ul>
      </article>
    </section>

    {canManageAttendance && <>
      <section className="content-card manual-attendance-card">
        <div className="card-heading"><div><p className="eyebrow">HR / ADMINISTRATION</p><h2>Record employee attendance manually</h2><p className="muted-copy">Working time beyond the employee’s scheduled day is added automatically. Every worked minute on a saved weekend or holiday is overtime. The approved overtime field can only increase that automatic amount.</p></div><CalendarPlus size={21} /></div>
        {employeesQuery.isPending ? <p className="muted-copy">Loading employees…</p> : employeesQuery.isError ? <p className="form-error">{employeesQuery.error.message}</p> : <form onSubmit={(event) => void saveManualAttendance(event)}>
          <div className="form-grid manual-attendance-form-grid">
            <label className="field field--wide"><span>Employee *</span><select value={manual.employeeId} onChange={(event) => setManual((current) => ({ ...current, employeeId: event.target.value }))} required><option value="">Select employee…</option>{employeesQuery.data?.data.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}{employee.designation ? ` · ${employee.designation}` : ''}</option>)}</select></label>
            <label className="field"><span>Attendance date *</span><input type="date" value={manual.date} onChange={(event) => setManual((current) => ({ ...current, date: event.target.value }))} required /></label>
            <label className="field"><span>Status *</span><select value={manual.status} onChange={(event) => setManual((current) => ({ ...current, status: event.target.value, working_hours: ['absent', 'leave'].includes(event.target.value) ? '0' : current.working_hours }))}><option value="present">Present</option><option value="half_day">Half day</option><option value="absent">Absent</option><option value="leave">Leave</option></select></label>
            <label className="field"><span>Working hours</span><input type="number" min="0" max="24" step="0.25" value={manual.working_hours} onChange={(event) => setManual((current) => ({ ...current, working_hours: event.target.value }))} /></label>
            <label className="field"><span>Break minutes</span><input type="number" min="0" max="720" step="1" value={manual.break_minutes} onChange={(event) => setManual((current) => ({ ...current, break_minutes: event.target.value }))} /></label>
            <label className="field"><span>Approved overtime minutes</span><input type="number" min="0" max="1440" step="1" value={manual.overtime_minutes} onChange={(event) => setManual((current) => ({ ...current, overtime_minutes: event.target.value }))} /></label>
            <label className="field"><span>Check in</span><input type="time" value={manual.check_in} onChange={(event) => setManual((current) => ({ ...current, check_in: event.target.value }))} /></label>
            <label className="field"><span>Check out</span><input type="time" value={manual.check_out} onChange={(event) => setManual((current) => ({ ...current, check_out: event.target.value }))} /></label>
            <label className="field field--wide"><span>HR note</span><textarea rows={3} maxLength={2000} value={manual.note} onChange={(event) => setManual((current) => ({ ...current, note: event.target.value }))} placeholder="Reason for manual record or correction" /></label>
          </div>
          {manualError && <p className="form-error">{manualError}</p>}{manualMessage && <p className="form-success">{manualMessage}</p>}
          <div className="modal-actions"><button className="button" type="submit" disabled={savingManual}><Save size={16} /> {savingManual ? 'Saving attendance…' : 'Save employee attendance'}</button></div>
        </form>}
      </section>

      <section className="content-card manual-attendance-card">
        <div className="card-heading"><div><p className="eyebrow">HOLIDAY OVERTIME CALENDAR</p><h2>Company holidays</h2><p className="muted-copy">Add a public holiday once. Any employee who works on that date receives overtime for all recorded working minutes.</p></div><CalendarDays size={21} /></div>
        <form onSubmit={(event) => void saveHoliday(event)}>
          <div className="form-grid manual-attendance-form-grid">
            <label className="field"><span>Holiday date *</span><input type="date" value={holiday.date} onChange={(event) => setHoliday((current) => ({ ...current, date: event.target.value }))} required /></label>
            <label className="field"><span>Holiday name *</span><input value={holiday.name} onChange={(event) => setHoliday((current) => ({ ...current, name: event.target.value }))} maxLength={160} placeholder="e.g. Diwali" required /></label>
            <label className="field field--wide"><span>Note</span><input value={holiday.note} onChange={(event) => setHoliday((current) => ({ ...current, note: event.target.value }))} maxLength={1000} placeholder="Optional internal note" /></label>
          </div>
          {holidayError && <p className="form-error">{holidayError}</p>}{holidayMessage && <p className="form-success">{holidayMessage}</p>}
          <div className="modal-actions"><button className="button" type="submit" disabled={savingHoliday}><Save size={16} /> {savingHoliday ? 'Saving holiday…' : 'Save holiday'}</button></div>
        </form>
        {holidaysQuery.isPending ? <p className="muted-copy">Loading holidays…</p> : holidaysQuery.isError ? <p className="form-error">{holidaysQuery.error.message}</p> : <ul className="simple-list">{holidaysQuery.data?.data.map((entry) => <li key={entry.id}><strong>{displayValue(entry.fields.name)}</strong><span>{displayValue(entry.fields.date)} <button className="icon-button" type="button" aria-label={`Remove ${displayValue(entry.fields.name)}`} onClick={() => void removeHoliday(entry.id)}><Trash2 size={15} /></button></span></li>)}{!holidaysQuery.data?.data.length && <li className="muted-copy">No holidays saved for this year.</li>}</ul>}
      </section>
    </>}
  </>;
}

function isAdminOrHr(role: string | undefined): boolean {
  return ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource'].includes(String(role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function duration(value: number): string {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`;
}

function overtimeRuleLabel(policy: OvertimePolicy): string {
  if (policy.dayType === 'holiday') return `${policy.holidayName ?? 'This holiday'}: every worked minute is overtime.`;
  if (policy.dayType === 'weekend') return 'Weekend: every worked minute is overtime.';
  return `Working day: time after ${duration(policy.scheduledMinutes)} is overtime.`;
}

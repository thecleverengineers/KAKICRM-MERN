import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BriefcaseBusiness, CalendarDays, CheckSquare, CircleDollarSign, Clock3, KeyRound, LockKeyhole, Pencil, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { StatusPill } from '../components/StatusPill.js';
import { resourceById } from '../config/resources.js';
import { api, type PublicRecord } from '../lib/api.js';
import { type EmployeeWorkspace } from '../lib/employees.js';
import { date, dateTime, displayValue, money } from '../lib/format.js';
import { TASK_KANBAN_COLUMNS, taskStatus } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';

export function EmployeeDetailPage() {
  const { employeeId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { hasPermission } = useAuth();
  const [editing, setEditing] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['employee-workspace', employeeId],
    enabled: Boolean(employeeId),
    queryFn: () => api<EmployeeWorkspace>(`/employees/${employeeId}`)
  });
  const employeeResource = resourceById.get('users');

  if (query.isPending) return <LoadingState label="Loading employee workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const workspace = query.data;
  const employee = workspace.employee;
  const employeeName = valueText(employee.fields.name) || `Employee #${employee.legacyId ?? ''}`;
  const department = valueText(employee.fields.department);
  const designation = valueText(employee.fields.designation);
  const role = valueText(employee.fields.role) || 'Employee';
  const status = valueText(employee.fields.status) || 'active';
  const canManageEmployee = workspace.access.canManageEmployee && hasPermission('employees.manage');
  const canOpenTasks = hasPermission('task.view') || hasPermission('task.manage') || hasPermission('task.update');
  const canOpenTeams = hasPermission('teams.view') || hasPermission('teams.manage');
  const canOpenProjects = hasPermission('departments.view') || hasPermission('departments.manage') || hasPermission('projects.view') || hasPermission('projects.manage');

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['employee-workspace', employeeId] }),
      client.invalidateQueries({ queryKey: ['records', 'users'] }),
      client.invalidateQueries({ queryKey: ['record', 'users', employeeId] }),
      client.invalidateQueries({ queryKey: ['live-workforce'] })
    ]);
  };
  const saveEmployee = async (fields: Record<string, unknown>) => {
    await api(`/records/users/${employeeId}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
    await refresh();
  };
  const savePassword = async (password: string) => {
    await api(`/employees/${employeeId}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    setSecurityMessage(`Password saved for ${employeeName}. The previous password can no longer be used.`);
    await refresh();
  };

  return <>
    <PageHeader
      eyebrow="EMPLOYEE WORKSPACE"
      title={employeeName}
      description={[designation, department].filter(Boolean).join(' · ') || 'Employee assignments, attendance, payroll and account access in one place.'}
      actions={<>
        <button className="button button--secondary" onClick={() => navigate('/data/users')}><ArrowLeft size={17} /> All employees</button>
        {canManageEmployee && <button className="button button--secondary" onClick={() => setEditing(true)}><Pencil size={17} /> Edit employee</button>}
        {workspace.access.canManagePassword && <button className="button" onClick={() => { setSecurityMessage(null); setPasswordOpen(true); }}><KeyRound size={17} /> {workspace.passwordConfigured ? 'Change password' : 'Create password'}</button>}
      </>}
    />

    <section className="employee-identity-card content-card" aria-label="Employee profile">
      <span className="employee-identity-avatar">{initials(employeeName)}</span>
      <div className="employee-identity-copy">
        <p className="eyebrow">EMPLOYEE PROFILE</p>
        <h2>{employeeName}</h2>
        <p>{designation || 'Designation not set'}{department ? ` · ${department}` : ''}</p>
        <div className="employee-identity-meta">
          <span>{valueText(employee.fields.email) || 'No email added'}</span>
          <span>{valueText(employee.fields.phone) || 'No phone added'}</span>
          <span>Joined {date(employee.fields.joining_date)}</span>
        </div>
      </div>
      <div className="employee-identity-status">
        <StatusPill value={status} />
        <span><ShieldCheck size={15} /> {role}</span>
      </div>
    </section>

    <section className="employee-workspace-summary" aria-label="Employee workflow summary">
      <SummaryCard icon={<CheckSquare size={18} />} label="Assigned tasks" value={workspace.analytics.totalTasks} detail={`${workspace.analytics.completedTasks} completed`} />
      <SummaryCard icon={<Clock3 size={18} />} label="Open workflow" value={workspace.analytics.openTasks} detail={workspace.analytics.overdueTasks ? `${workspace.analytics.overdueTasks} overdue` : 'On track'} />
      <SummaryCard icon={<UsersRound size={18} />} label="Assigned teams" value={workspace.analytics.teamCount} detail={workspace.analytics.teamCount === 1 ? 'team membership' : 'team memberships'} />
      <SummaryCard icon={<BriefcaseBusiness size={18} />} label="Assigned projects" value={workspace.analytics.projectCount} detail={`${workspace.analytics.taskCompletionRate}% task completion`} />
      <SummaryCard icon={<CalendarDays size={18} />} label="Attendance" value={workspace.attendance.allowed ? workspace.attendance.summary.presentDays : '—'} detail={workspace.attendance.allowed ? 'present days recorded' : 'Restricted by role'} />
    </section>

    <section className="employee-workspace-layout">
      <article className="employee-task-board-card content-card">
        <div className="card-heading"><div><p className="eyebrow">ASSIGNED TASKS</p><h2>Personal workflow</h2><p className="employee-card-description">Every task directly assigned to this employee, grouped by its current workflow stage.</p></div><span className="soft-count">{workspace.analytics.totalTasks} tasks</span></div>
        <div className="kanban-board employee-task-kanban" aria-label={`${employeeName} task kanban board`}>
          {TASK_KANBAN_COLUMNS.map((column) => {
            const tasks = workspace.tasks.filter((task) => taskStatus(task.fields.status) === column.id);
            return <section className={`kanban-column kanban-column--employee-${column.id}`} key={column.id}>
              <header><div><span>{column.label}</span><b>{tasks.length}</b></div></header>
              <div className="kanban-column__items">
                {tasks.map((task) => <EmployeeTaskCard key={task.id} task={task} canOpen={canOpenTasks} onOpen={() => navigate(`/tasks/${task.legacyId}`)} />)}
                {!tasks.length && <div className="kanban-empty">No tasks</div>}
              </div>
            </section>;
          })}
        </div>
      </article>

      <aside className="employee-profile-side">
        <article className="employee-profile-card content-card">
          <div className="card-heading"><div><p className="eyebrow">EMPLOYMENT DETAILS</p><h2>Profile & access</h2></div><UserRound size={19} /></div>
          <dl className="employee-profile-list">
            <ProfileRow label="Department" value={department || 'Not assigned'} />
            <ProfileRow label="Designation" value={designation || 'Not assigned'} />
            <ProfileRow label="Role" value={role} />
            <ProfileRow label="Employee status" value={status} />
            <ProfileRow label="Email" value={valueText(employee.fields.email) || 'Not added'} />
            <ProfileRow label="Phone" value={valueText(employee.fields.phone) || 'Not added'} />
          </dl>
        </article>

        <article className="employee-security-card content-card">
          <div className="card-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>Employee password</h2></div><LockKeyhole size={19} /></div>
          {workspace.access.canManagePassword ? <><p>{workspace.passwordConfigured ? 'Set a replacement password when the employee needs access restored or their credentials need to be changed.' : 'This employee does not yet have a login password. Create one securely from here.'}</p><button className="button button--secondary employee-security-action" onClick={() => { setSecurityMessage(null); setPasswordOpen(true); }}><KeyRound size={16} /> {workspace.passwordConfigured ? 'Change password' : 'Create password'}</button>{securityMessage && <div className="employee-security-success">{securityMessage}</div>}</> : <p>You have read-only employee access. Passwords can only be managed by an authorised administrator or HR manager.</p>}
        </article>
      </aside>
    </section>

    <section className="employee-assignment-grid">
      <article className="employee-assignment-card content-card">
        <div className="card-heading"><div><p className="eyebrow">ASSIGNED TEAM</p><h2>Team memberships</h2></div><span className="soft-count">{workspace.teams.length}</span></div>
        <div className="employee-assignment-list">
          {workspace.teams.map((team) => <EmployeeTeamRow key={team.data.id} team={team} canOpen={canOpenTeams} onOpen={() => navigate(`/data/teams/${team.data.legacyId}`)} />)}
          {!workspace.teams.length && <EmptyAssignment icon={<UsersRound size={20} />} title="No team assignment" detail="Assign this employee to a team to connect their workflow and projects." />}
        </div>
      </article>

      <article className="employee-assignment-card content-card">
        <div className="card-heading"><div><p className="eyebrow">ASSIGNED PROJECTS</p><h2>Project involvement</h2></div><span className="soft-count">{workspace.projects.length}</span></div>
        <div className="employee-project-list">
          {workspace.projects.map((project) => <EmployeeProjectCard key={project.data.id} project={project} canOpen={canOpenProjects} onOpen={() => {
            const departmentId = Number(project.data.fields.department_id);
            if (Number.isSafeInteger(departmentId) && departmentId > 0 && project.data.legacyId) navigate(`/data/departments/${departmentId}/projects/${project.data.legacyId}`);
          }} />)}
          {!workspace.projects.length && <EmptyAssignment icon={<BriefcaseBusiness size={20} />} title="No project assignment" detail="Projects appear here when the employee is the project head, a team member, or has an assigned project task." />}
        </div>
      </article>
    </section>

    <section className="employee-insights-grid">
      <article className="employee-attendance-card content-card">
        <div className="card-heading"><div><p className="eyebrow">ATTENDANCE</p><h2>Recent workdays</h2></div><CalendarDays size={19} /></div>
        {workspace.attendance.allowed ? <>
          <div className="employee-attendance-metrics"><Metric label="Present" value={workspace.attendance.summary.presentDays} /><Metric label="Half days" value={workspace.attendance.summary.halfDays} /><Metric label="Work time" value={duration(workspace.attendance.summary.totalMinutes)} /></div>
          <div className="employee-attendance-list">
            {workspace.attendance.records.slice(0, 12).map((record) => <div key={record.id}><span><strong>{date(record.fields.work_date ?? record.fields.date)}</strong><small>{dateTime(record.fields.check_in ?? record.fields.shift_start_ist)}</small></span><StatusPill value={record.fields.status} /><b>{duration(Number(record.fields.total_minutes ?? 0))}</b></div>)}
            {!workspace.attendance.records.length && <div className="employee-data-empty">No attendance record is available yet.</div>}
          </div>
        </> : <RestrictedPanel icon={<CalendarDays size={20} />} message="Attendance is restricted for your role. Grant attendance access to review this employee’s workday history." />}
      </article>

      <article className="employee-salary-card content-card">
        <div className="card-heading"><div><p className="eyebrow">SALARY & PAYROLL</p><h2>Compensation history</h2></div><CircleDollarSign size={19} /></div>
        {workspace.salary.allowed ? <>
          <div className="employee-salary-summary"><div><small>Monthly salary</small><strong>{workspace.salary.summary.monthlySalary === null ? '—' : money(workspace.salary.summary.monthlySalary)}</strong></div><div><small>Latest net pay</small><strong>{workspace.salary.summary.latestNetPay === null ? '—' : money(workspace.salary.summary.latestNetPay)}</strong><span>{workspace.salary.summary.currentPeriod ? `Period · ${workspace.salary.summary.currentPeriod}` : 'No payroll period'}</span></div></div>
          <div className="employee-payroll-list">
            {workspace.salary.payroll.slice(0, 5).map((record) => <div key={record.id}><span><strong>{displayValue(record.fields.period_month)}</strong><small>{displayValue(record.fields.salary_status)}</small></span><b>{money(record.fields.net_pay ?? record.fields.gross_pay)}</b></div>)}
            {!workspace.salary.payroll.length && <div className="employee-data-empty">No payroll run is available yet. Salary profile records remain ready for the next calculation.</div>}
          </div>
        </> : <RestrictedPanel icon={<CircleDollarSign size={20} />} message="Salary details are restricted for your role. Grant payroll or salary access to review compensation." />}
      </article>
    </section>

    {employeeResource && <RecordFormDialog open={editing} resource={employeeResource} record={employee} onClose={() => setEditing(false)} onSubmit={saveEmployee} />}
    <EmployeePasswordDialog open={passwordOpen} employeeName={employeeName} configured={workspace.passwordConfigured} onClose={() => setPasswordOpen(false)} onSubmit={savePassword} />
  </>;
}

function EmployeeTaskCard({ task, canOpen, onOpen }: { task: PublicRecord; canOpen: boolean; onOpen: () => void }) {
  const content = <><div className="kanban-task-card__top"><StatusPill value={task.fields.priority} /><span>{date(task.fields.due_date)}</span></div><h3>{displayValue(task.fields.title)}</h3><p>{displayValue(task.fields.description)}</p><footer><span>{displayValue(task.relationLabels?.project_id ?? task.fields.project_id ?? 'Direct assignment')}</span><small>{displayValue(task.relationLabels?.team_id ?? task.fields.team_id ?? 'Personal task')}</small></footer></>;
  return canOpen && task.legacyId ? <button type="button" className="kanban-task-card employee-task-card" onClick={onOpen}>{content}</button> : <article className="kanban-task-card employee-task-card employee-task-card--static">{content}</article>;
}

function EmployeeTeamRow({ team, canOpen, onOpen }: { team: EmployeeWorkspace['teams'][number]; canOpen: boolean; onOpen: () => void }) {
  const content = <><span className="employee-assignment-avatar">{initials(valueText(team.data.fields.name) || 'Team')}</span><span className="employee-assignment-copy"><strong>{displayValue(team.data.fields.name)}</strong><small>{displayValue(team.data.fields.description)}</small></span><b>{team.role}</b></>;
  return canOpen && team.data.legacyId ? <button type="button" className="employee-assignment-row" onClick={onOpen}>{content}</button> : <article className="employee-assignment-row employee-assignment-row--static">{content}</article>;
}

function EmployeeProjectCard({ project, canOpen, onOpen }: { project: EmployeeWorkspace['projects'][number]; canOpen: boolean; onOpen: () => void }) {
  const departmentId = Number(project.data.fields.department_id);
  const isOpenable = canOpen && project.data.legacyId && Number.isSafeInteger(departmentId) && departmentId > 0;
  const content = <><div className="employee-project-card__heading"><StatusPill value={project.data.fields.status} /><span>{project.assignments.join(' · ')}</span></div><h3>{displayValue(project.data.fields.name)}</h3><p>{displayValue(project.data.fields.description)}</p><footer><span>{project.analytics.completedTasks}/{project.analytics.totalTasks} tasks complete</span><b>{project.analytics.taskCompletionRate}%</b></footer></>;
  return isOpenable ? <button type="button" className="employee-project-card" onClick={onOpen}>{content}</button> : <article className="employee-project-card employee-project-card--static">{content}</article>;
}

function SummaryCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string | number; detail: string }) {
  return <article><span className="project-summary-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>;
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><small>{label}</small><strong>{value}</strong></div>;
}

function EmptyAssignment({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="employee-assignment-empty">{icon}<strong>{title}</strong><span>{detail}</span></div>;
}

function RestrictedPanel({ icon, message }: { icon: ReactNode; message: string }) {
  return <div className="employee-restricted-panel">{icon}<p>{message}</p></div>;
}

function EmployeePasswordDialog({ open, employeeName, configured, onClose, onSubmit }: { open: boolean; employeeName: string; configured: boolean; onClose: () => void; onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setConfirmation('');
    setSaving(false);
    setError(null);
  }, [open]);
  if (!open) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('The password confirmation does not match.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(password);
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The employee password could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal employee-password-modal" role="dialog" aria-modal="true" aria-label={`${configured ? 'Change' : 'Create'} employee password`} onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>{configured ? 'Change password' : 'Create password'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></div><p className="employee-password-copy">Set a secure login password for <strong>{employeeName}</strong>. Passwords are never displayed or recoverable after saving.</p><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>New password *</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required autoFocus /></label><label className="field field--wide"><span>Confirm password *</span><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" type="submit" disabled={saving}>{saving ? 'Saving…' : configured ? 'Save new password' : 'Create password'}</button></div></form></section></div>;
}

function valueText(value: unknown): string {
  const result = displayValue(value);
  return result === '—' ? '' : result;
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'E';
}

function duration(value: number): string {
  const minutes = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecordWithRelations, toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { can } from '../services/permissions.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const passwordSchema = z.object({
  password: z.string().min(8, 'Use at least 8 characters.').max(128, 'Password is too long.')
});

const taskStatuses = ['pending', 'in_progress', 'review', 'completed', 'blocked'] as const;

export const employeesRouter = Router();
employeesRouter.use(requireAuth);

employeesRouter.get('/:userId', requireEmployeeRead, asyncHandler(async (req, res) => {
  const employeeId = idParam(req.params.userId, 'employee');
  const employee = await findLegacyRecord('users', employeeId);
  if (!employee) throw new HttpError(404, 'Employee not found.');

  const canViewAttendance = can(req.auth!, 'employees.manage') || can(req.auth!, 'attendance.view') || can(req.auth!, 'attendance.manage');
  const canViewSalary = can(req.auth!, 'employees.manage') || can(req.auth!, 'payroll.view') || can(req.auth!, 'salary.view');

  const [taskRows, membershipRows, leaderTeamRows, attendanceLogs, attendanceShifts, payrollRows, salaryProfiles, salaryStructures, salarySlips] = await Promise.all([
    listRawRecords('tasks', { $or: [{ 'raw.assignee_id': employeeId }, { 'raw.assignee_ids': employeeId }] }, 5_000),
    listRawRecords('team_members', { 'raw.user_id': employeeId }, 5_000),
    listRawRecords('teams', { 'raw.leader_id': employeeId }, 5_000),
    canViewAttendance ? listRawRecords('attendance_logs', { 'raw.user_id': employeeId }, 366) : Promise.resolve([]),
    canViewAttendance ? listRawRecords('attendance_shifts', { 'raw.user_id': employeeId }, 366) : Promise.resolve([]),
    canViewSalary ? listRawRecords('payroll_monthly', { 'raw.user_id': employeeId }, 120) : Promise.resolve([]),
    canViewSalary ? listRawRecords('salary_profiles', { 'raw.user_id': employeeId }, 50) : Promise.resolve([]),
    canViewSalary ? listRawRecords('salary_structures', { 'raw.user_id': employeeId }, 50) : Promise.resolve([]),
    canViewSalary ? listRawRecords('salary_slips', { 'raw.user_id': employeeId }, 120) : Promise.resolve([])
  ]);

  const memberRoleByTeamId = new Map<number, string>();
  for (const membership of membershipRows) {
    const teamId = numeric(membership.raw.team_id);
    if (teamId) memberRoleByTeamId.set(teamId, text(membership.raw.role_in_team) || 'Team member');
  }
  const teamIds = [...new Set([...memberRoleByTeamId.keys(), ...leaderTeamRows.map(recordId)])];
  const memberTeamRows = teamIds.length
    ? await listRawRecords('teams', { legacyId: { $in: teamIds } }, 5_000)
    : [];
  const teamRows = uniqueRecords([...leaderTeamRows, ...memberTeamRows]);
  const leaderTeamIds = new Set(leaderTeamRows.map(recordId));

  const taskProjectIds = uniqueIds(taskRows.map((task) => numeric(task.raw.project_id)));
  const [leadProjectRows, teamProjectRows, taskProjectRows] = await Promise.all([
    listRawRecords('department_projects', { 'raw.lead_user_id': employeeId }, 5_000),
    teamIds.length ? listRawRecords('department_projects', { 'raw.team_id': { $in: teamIds } }, 10_000) : Promise.resolve([]),
    taskProjectIds.length ? listRawRecords('department_projects', { legacyId: { $in: taskProjectIds } }, 10_000) : Promise.resolve([])
  ]);
  const projectRows = uniqueRecords([...leadProjectRows, ...teamProjectRows, ...taskProjectRows]);
  const projectIds = projectRows.map(recordId);
  const projectTaskRows = projectIds.length
    ? await listRawRecords('tasks', { 'raw.project_id': { $in: projectIds } }, 20_000)
    : [];
  const projectTasksById = groupByProject(projectTaskRows);

  const [publicEmployee, publicTasks, publicTeams, publicProjects] = await Promise.all([
    toPublicRecordWithRelations('users', employee),
    toPublicRecordsWithRelations('tasks', taskRows),
    toPublicRecordsWithRelations('teams', teamRows),
    toPublicRecordsWithRelations('department_projects', projectRows)
  ]);
  const attendanceRows = attendanceLogs.length ? attendanceLogs : attendanceShifts;
  const taskProjectIdSet = new Set(taskProjectIds);
  const teamIdSet = new Set(teamIds);

  res.json({
    employee: publicEmployee,
    tasks: publicTasks,
    teams: publicTeams.map((data, index) => {
      const teamId = recordId(teamRows[index]);
      return {
        data,
        role: leaderTeamIds.has(teamId) ? 'Team leader' : memberRoleByTeamId.get(teamId) ?? 'Team member'
      };
    }),
    projects: publicProjects.map((data, index) => {
      const project = projectRows[index];
      const projectId = recordId(project);
      const assignments: string[] = [];
      if (numeric(project.raw.lead_user_id) === employeeId) assignments.push('Project head');
      if (teamIdSet.has(numeric(project.raw.team_id) ?? -1)) assignments.push('Team assignment');
      if (taskProjectIdSet.has(projectId)) assignments.push('Assigned task');
      return {
        data,
        assignments: assignments.length ? assignments : ['Assigned project'],
        analytics: taskMetrics(projectTasksById.get(projectId) ?? [])
      };
    }),
    attendance: {
      allowed: canViewAttendance,
      records: attendanceRows.map(toPublicRecord),
      summary: attendanceMetrics(attendanceRows)
    },
    salary: {
      allowed: canViewSalary,
      profiles: salaryProfiles.map(toPublicRecord),
      structures: salaryStructures.map(toPublicRecord),
      payroll: payrollRows.map(toPublicRecord),
      slips: salarySlips.map(toPublicRecord),
      summary: salaryMetrics(salaryProfiles, salaryStructures, payrollRows)
    },
    analytics: employeeMetrics(taskRows, teamRows.length, projectRows),
    access: {
      canManageEmployee: can(req.auth!, 'employees.manage'),
      canManagePassword: can(req.auth!, 'employees.manage'),
      canViewAttendance,
      canViewSalary
    },
    passwordConfigured: hasPassword(employee)
  });
}));

employeesRouter.post('/:userId/password', requireEmployeeManage, asyncHandler(async (req, res) => {
  const employeeId = idParam(req.params.userId, 'employee');
  const input = passwordSchema.parse(req.body);
  const employee = await findLegacyRecord('users', employeeId);
  if (!employee) throw new HttpError(404, 'Employee not found.');

  // Do not overwrite legacy password data. A new bcrypt hash takes precedence
  // during login, preserves the original migrated source, and invalidates the
  // previous password without ever exposing either value to the browser.
  const passwordHash = await bcrypt.hash(input.password, 12);
  const updated = await updateLegacyRecord('users', employeeId, {
    password_hash: passwordHash,
    password_updated_at: nowIst(),
    password_updated_by: req.auth!.legacyId,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Employee not found.');

  emitRealtime('employee:password-updated', { employeeId, updatedBy: req.auth!.legacyId }, `user:${employeeId}`);
  res.json({ message: 'Employee password saved.', passwordConfigured: true });
}));

function requireEmployeeRead(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'employees.view') && !can(req.auth, 'employees.manage')) {
    res.status(403).json({ error: 'You do not have permission to view employee profiles.' });
    return;
  }
  next();
}

function requireEmployeeManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'employees.manage')) {
    res.status(403).json({ error: 'You do not have permission to manage employee passwords.' });
    return;
  }
  next();
}

function idParam(value: string | string[] | undefined, label: string): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${label} ID.`);
  return parsed;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function recordId(record: LegacyRecord): number {
  const id = record.legacyId ?? numeric(record.raw.id);
  if (!id) throw new HttpError(500, 'A legacy record has no usable ID.');
  return id;
}

function uniqueIds(values: Array<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => value !== null))];
}

function uniqueRecords(records: LegacyRecord[]): LegacyRecord[] {
  const output = new Map<number, LegacyRecord>();
  for (const record of records) output.set(recordId(record), record);
  return [...output.values()];
}

function groupByProject(tasks: LegacyRecord[]): Map<number, LegacyRecord[]> {
  const grouped = new Map<number, LegacyRecord[]>();
  for (const task of tasks) {
    const projectId = numeric(task.raw.project_id);
    if (!projectId) continue;
    const current = grouped.get(projectId) ?? [];
    current.push(task);
    grouped.set(projectId, current);
  }
  return grouped;
}

function taskMetrics(tasks: LegacyRecord[]) {
  const completedTasks = tasks.filter((task) => taskStatus(task.raw.status) === 'completed').length;
  const openTasks = tasks.length - completedTasks;
  return {
    totalTasks: tasks.length,
    completedTasks,
    openTasks,
    taskCompletionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0
  };
}

function employeeMetrics(tasks: LegacyRecord[], teamCount: number, projects: LegacyRecord[]) {
  const statusCounts = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<(typeof taskStatuses)[number], number>;
  let overdueTasks = 0;
  const today = todayIst();
  for (const task of tasks) {
    const status = taskStatus(task.raw.status);
    statusCounts[status] += 1;
    const dueDate = text(task.raw.due_date).slice(0, 10);
    if (dueDate && dueDate < today && status !== 'completed') overdueTasks += 1;
  }
  const completedTasks = statusCounts.completed;
  return {
    totalTasks: tasks.length,
    openTasks: tasks.length - completedTasks,
    completedTasks,
    overdueTasks,
    taskCompletionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0,
    tasksByStatus: statusCounts,
    teamCount,
    projectCount: projects.length
  };
}

function attendanceMetrics(records: LegacyRecord[]) {
  const output = { totalDays: records.length, presentDays: 0, halfDays: 0, absentDays: 0, leaveDays: 0, totalMinutes: 0, latestCheckIn: null as string | null };
  for (const record of records) {
    const status = text(record.raw.status).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
    if (['present', 'working', 'completed'].includes(status)) output.presentDays += 1;
    else if (status === 'half_day') output.halfDays += 1;
    else if (status === 'leave' || status === 'on_leave') output.leaveDays += 1;
    else if (status === 'absent') output.absentDays += 1;
    output.totalMinutes += finiteNumber(record.raw.total_minutes);
    if (!output.latestCheckIn) {
      const value = text(record.raw.check_in ?? record.raw.shift_start_ist);
      if (value) output.latestCheckIn = value;
    }
  }
  return output;
}

function salaryMetrics(profiles: LegacyRecord[], structures: LegacyRecord[], payroll: LegacyRecord[]) {
  const profile = profiles[0]?.raw ?? {};
  const structure = structures[0]?.raw ?? {};
  const latestPayroll = payroll[0]?.raw ?? {};
  const monthlySalary = firstMoney(profile.monthly_salary, structure.base_salary, latestPayroll.monthly_salary, latestPayroll.gross_pay);
  const latestNetPay = firstMoney(latestPayroll.net_pay, latestPayroll.gross_pay);
  return {
    monthlySalary,
    latestNetPay,
    currentPeriod: text(latestPayroll.period_month) || null,
    fixedAllowance: firstMoney(profile.fixed_allowance, structure.allowances),
    fixedDeduction: firstMoney(profile.fixed_deduction, structure.deductions)
  };
}

function firstMoney(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskStatus(value: unknown): (typeof taskStatuses)[number] {
  const normalized = text(value).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'review') return 'review';
  if (normalized === 'in_progress' || normalized === 'active') return 'in_progress';
  return 'pending';
}

function hasPassword(employee: LegacyRecord): boolean {
  return Boolean(text(employee.raw.password_hash ?? employee.raw.password));
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

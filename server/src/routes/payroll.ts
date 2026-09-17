import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { canManagePayroll, canViewPayroll } from '../services/permissions.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const monthSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
  userId: z.coerce.number().int().positive().optional()
});

const salaryStructureSchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD for the effective date.'),
  base_salary: z.coerce.number().positive().max(100_000_000),
  allowances: z.coerce.number().min(0).max(100_000_000).default(0),
  incentives: z.coerce.number().min(0).max(100_000_000).default(0),
  deductions: z.coerce.number().min(0).max(100_000_000).default(0),
  ot_hourly_rate: z.coerce.number().min(0).max(1_000_000).default(0),
  working_hours_per_day: z.coerce.number().min(0.25).max(24).default(8),
  notes: z.string().trim().max(2_000).optional().nullable()
});

export const payrollRouter = Router();
payrollRouter.use(requireAuth);

payrollRouter.get('/employees', requirePayrollView, asyncHandler(async (_req, res) => {
  const users = await listRawRecords('users', {}, 2_000);
  const data = users
    .filter((user) => isActive(user.raw.status))
    .map((user) => ({
      id: user.legacyId!,
      label: employeeName(user),
      department: text(user.raw.department),
      designation: text(user.raw.designation),
      employeeCode: firstText(user.raw.employee_code, user.raw.emp_code, user.raw.code)
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  res.json({ data });
}));

payrollRouter.get('/employees/:userId', requirePayrollView, asyncHandler(async (req, res) => {
  const userId = idParam(req.params.userId, 'employee');
  const employee = await requireEmployee(userId);
  const [profiles, structures, payroll, slips] = await Promise.all([
    listRawRecords('salary_profiles', { 'raw.user_id': userId }, 100),
    listRawRecords('salary_structures', { 'raw.user_id': userId }, 100),
    listRawRecords('payroll_monthly', { 'raw.user_id': userId }, 120),
    listRawRecords('salary_slips', { 'raw.user_id': userId }, 120)
  ]);
  res.json({
    employee: toPublicRecord(employee),
    activeStructure: toPublicRecord(selectEffectiveStructure(structures, todayIst()) ?? structures[0] ?? profiles[0] ?? employee),
    salaryProfiles: profiles.map(toPublicRecord),
    salaryStructures: structures.sort((left, right) => structureDate(right).localeCompare(structureDate(left))).map(toPublicRecord),
    payroll: payroll.map(toPublicRecord),
    slips: slips.map(toPublicRecord)
  });
}));

payrollRouter.put('/employees/:userId/salary-structure', requirePayrollManage, asyncHandler(async (req, res) => {
  const userId = idParam(req.params.userId, 'employee');
  await requireEmployee(userId);
  const input = salaryStructureSchema.parse(req.body);
  const now = nowIst();
  const structures = await listRawRecords('salary_structures', { 'raw.user_id': userId }, 200);
  const existingForDate = structures.find((record) => String(record.raw.effective_from ?? '').slice(0, 10) === input.effective_from);
  const fields = {
    user_id: userId,
    effective_from: input.effective_from,
    base_salary: roundMoney(input.base_salary),
    allowances: roundMoney(input.allowances),
    incentives: roundMoney(input.incentives),
    deductions: roundMoney(input.deductions),
    ot_hourly_rate: roundMoney(input.ot_hourly_rate),
    working_hours_per_day: roundHours(input.working_hours_per_day),
    notes: input.notes ?? null,
    is_active: 1,
    updated_by: req.auth!.legacyId,
    updated_at: now
  };
  const structure = existingForDate?.legacyId
    ? await updateLegacyRecord('salary_structures', existingForDate.legacyId, fields)
    : await createLegacyRecord('salary_structures', { ...fields, created_by: req.auth!.legacyId, created_at: now });
  if (!structure) throw new HttpError(404, 'Salary structure could not be saved.');

  // Keep the legacy salary-profile fallback current for existing record pages.
  // Calculations still prefer the dated structure above, preserving history.
  const profiles = await listRawRecords('salary_profiles', { 'raw.user_id': userId, 'raw.is_active': { $ne: 0 } }, 20);
  const profileFields = {
    user_id: userId,
    monthly_salary: roundMoney(input.base_salary),
    fixed_allowance: roundMoney(input.allowances),
    fixed_incentive: roundMoney(input.incentives),
    fixed_deduction: roundMoney(input.deductions),
    ot_hourly_rate: roundMoney(input.ot_hourly_rate),
    working_hours_per_day: roundHours(input.working_hours_per_day),
    effective_from: input.effective_from,
    is_active: 1,
    updated_by: req.auth!.legacyId,
    updated_at: now
  };
  const profile = profiles[0]?.legacyId
    ? await updateLegacyRecord('salary_profiles', profiles[0].legacyId, profileFields)
    : await createLegacyRecord('salary_profiles', { ...profileFields, created_by: req.auth!.legacyId, created_at: now });
  res.json({ data: toPublicRecord(structure), profile: profile ? toPublicRecord(profile) : null });
}));

payrollRouter.get('/history/me', asyncHandler(async (req, res) => {
  const [records, slips] = await Promise.all([
    listRawRecords('payroll_monthly', { 'raw.user_id': req.auth!.legacyId }, 120),
    listRawRecords('salary_slips', { 'raw.user_id': req.auth!.legacyId }, 120)
  ]);
  res.json({ data: records.map(toPublicRecord), slips: slips.map(toPublicRecord) });
}));

payrollRouter.get('/runs', requirePayrollView, asyncHandler(async (_req, res) => {
  const runs = await listRawRecords('payroll_runs', {}, 120);
  res.json({ data: runs.map(toPublicRecord) });
}));

payrollRouter.post('/calculate', requirePayrollManage, asyncHandler(async (req, res) => {
  const input = monthSchema.parse(req.body);
  const period = monthPeriod(input.year, input.month);
  const users = input.userId
    ? [await requireEmployee(input.userId)]
    : (await listRawRecords('users', {}, 2_000)).filter((user) => isActive(user.raw.status));
  if (!users.length) throw new HttpError(404, 'No active employees were found for payroll calculation.');
  const run = await ensurePayrollRun(input.month, input.year, period, req.auth!.legacyId);
  const holidays = await listRawRecords('attendance_holidays', {
    'raw.date': { $gte: period.from, $lte: period.to }
  }, 1_000);
  const holidayDates = new Set(holidays.map((holiday) => text(holiday.raw.date)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const results = await Promise.all(users.map((user) => calculateUser(user, input.month, input.year, period, run.legacyId!, req.auth!.legacyId, holidayDates)));
  res.json({ data: results.map(toPublicRecord), run: toPublicRecord(run) });
}));

payrollRouter.post('/monthly/:payrollId/slip', requirePayrollManage, asyncHandler(async (req, res) => {
  const payrollId = idParam(req.params.payrollId, 'payroll record');
  const payroll = await findLegacyRecord('payroll_monthly', payrollId);
  if (!payroll) throw new HttpError(404, 'Payroll record not found.');
  const userId = numeric(payroll.raw.user_id);
  if (!userId) throw new HttpError(400, 'This payroll record has no employee.');
  const employee = await requireEmployee(userId);
  const [existing, structures] = await Promise.all([
    listRawRecords('salary_slips', { 'raw.payroll_id': payrollId }, 1),
    listRawRecords('salary_structures', { 'raw.user_id': userId }, 100)
  ]);
  const periodMonth = text(payroll.raw.period_month) || `${payroll.raw.year ?? ''}-${String(payroll.raw.month ?? '').padStart(2, '0')}`;
  const structure = selectEffectiveStructure(structures, text(payroll.raw.period_to) || `${periodMonth}-31`);
  const now = nowIst();
  const fields = salarySlipFields(payroll, employee, structure, req.auth!.legacyId, now);
  const slip = existing[0]?.legacyId
    ? await updateLegacyRecord('salary_slips', existing[0].legacyId, fields)
    : await createLegacyRecord('salary_slips', { ...fields, created_at: now });
  if (!slip) throw new HttpError(404, 'Salary slip could not be generated.');
  res.status(existing[0] ? 200 : 201).json(await salarySlipDetail(slip.legacyId!));
}));

payrollRouter.get('/slips/:slipId', asyncHandler(async (req, res) => {
  const slipId = idParam(req.params.slipId, 'salary slip');
  const slip = await findLegacyRecord('salary_slips', slipId);
  if (!slip) throw new HttpError(404, 'Salary slip not found.');
  const userId = numeric(slip.raw.user_id);
  if (!req.auth || (!canViewPayroll(req.auth) && userId !== req.auth.legacyId)) {
    throw new HttpError(403, 'You do not have permission to view this salary slip.');
  }
  res.json(await salarySlipDetail(slipId));
}));

async function salarySlipDetail(slipId: number): Promise<Record<string, unknown>> {
  const slip = await findLegacyRecord('salary_slips', slipId);
  if (!slip) throw new HttpError(404, 'Salary slip not found.');
  const userId = numeric(slip.raw.user_id);
  const payrollId = numeric(slip.raw.payroll_id);
  const [employee, payroll] = await Promise.all([
    userId ? findLegacyRecord('users', userId) : null,
    payrollId ? findLegacyRecord('payroll_monthly', payrollId) : null
  ]);
  return { data: toPublicRecord(slip), employee: employee ? toPublicRecord(employee) : null, payroll: payroll ? toPublicRecord(payroll) : null };
}

function salarySlipFields(payroll: LegacyRecord, employee: LegacyRecord, structure: LegacyRecord | null, generatedBy: number, generatedAt: string): Record<string, unknown> {
  const raw = payroll.raw;
  const period = text(raw.period_month);
  const employeeId = employee.legacyId!;
  return {
    payroll_id: payroll.legacyId,
    user_id: employeeId,
    slip_no: `SAL-${period.replace('-', '') || 'PAY'}-${String(employeeId).padStart(4, '0')}`,
    period_month: period,
    period_from: raw.period_from ?? null,
    period_to: raw.period_to ?? null,
    employee_name: employeeName(employee),
    employee_code: firstText(employee.raw.employee_code, employee.raw.emp_code, employee.raw.code),
    department: employee.raw.department ?? null,
    designation: employee.raw.designation ?? null,
    salary_structure_id: structure?.legacyId ?? raw.salary_structure_id ?? null,
    base_salary: money(raw.base_salary ?? raw.monthly_salary),
    fixed_allowance: money(raw.fixed_allowance),
    fixed_incentive: money(raw.fixed_incentive),
    ot_pay: money(raw.ot_pay),
    gross_pay: money(raw.gross_pay),
    fixed_deduction: money(raw.fixed_deduction),
    absence_deduction: money(raw.absence_deduction),
    half_day_deduction: money(raw.half_day_deduction),
    unpaid_leave_deduction: money(raw.unpaid_leave_deduction),
    total_deduction: money(raw.total_deduction),
    net_pay: money(raw.net_pay),
    present_days: money(raw.present_days),
    half_days: money(raw.half_days),
    leave_days: money(raw.leave_days),
    absent_days: money(raw.absent_days),
    work_minutes: money(raw.work_minutes),
    regular_work_minutes: money(raw.regular_work_minutes),
    approved_ot_minutes: money(raw.approved_ot_minutes),
    after_hours_ot_minutes: money(raw.after_hours_ot_minutes),
    weekend_ot_minutes: money(raw.weekend_ot_minutes),
    holiday_ot_minutes: money(raw.holiday_ot_minutes),
    generated_by: generatedBy,
    generated_at: generatedAt,
    status: 'generated',
    updated_at: generatedAt
  };
}

async function ensurePayrollRun(month: number, year: number, period: { from: string; to: string; days: number }, userId: number): Promise<LegacyRecord> {
  const existing = await listRawRecords('payroll_runs', { 'raw.month': month, 'raw.year': year }, 1);
  if (existing[0]) return existing[0];
  const sameYear = await listRawRecords('payroll_runs', { 'raw.year': year }, 1_000);
  return createLegacyRecord('payroll_runs', {
    month,
    year,
    period_from: period.from,
    period_to: period.to,
    run_date: nowIst(),
    status: 'calculated',
    notes: null,
    created_by: userId,
    days_in_month: period.days,
    run_no: sameYear.length + 1,
    created_at: nowIst(),
    updated_at: nowIst()
  });
}

async function calculateUser(
  user: LegacyRecord,
  month: number,
  year: number,
  period: { from: string; to: string; days: number },
  runId: number,
  calculatedBy: number,
  holidayDates: Set<string>
): Promise<LegacyRecord> {
  const userId = user.legacyId!;
  const [logs, leaves, profiles, structures, existing] = await Promise.all([
    listRawRecords('attendance_logs', { 'raw.user_id': userId, 'raw.date': { $gte: period.from, $lte: period.to } }, 1_000),
    listRawRecords('leave_requests', { 'raw.user_id': userId, 'raw.status': 'approved', 'raw.start_date': { $lte: period.to }, 'raw.end_date': { $gte: period.from } }, 1_000),
    listRawRecords('salary_profiles', { 'raw.user_id': userId, 'raw.is_active': { $ne: 0 } }, 100),
    listRawRecords('salary_structures', { 'raw.user_id': userId, 'raw.is_active': { $ne: 0 } }, 100),
    listRawRecords('payroll_monthly', { 'raw.user_id': userId, 'raw.period_month': `${year}-${String(month).padStart(2, '0')}` }, 1)
  ]);
  const profile = profiles[0]?.raw ?? {};
  const structure = selectEffectiveStructure(structures, period.to);
  const compensation = compensationFor(structure?.raw, profile);
  const attendance = summarizeAttendance(logs, leaves, period, compensation.workingHoursPerDay, holidayDates);
  const dailyRate = period.days ? compensation.baseSalary / period.days : 0;
  const absenceDeduction = roundMoney(attendance.absentDays * dailyRate);
  const halfDayDeduction = roundMoney(attendance.halfDays * dailyRate * 0.5);
  const otPay = roundMoney((attendance.overtimeMinutes / 60) * compensation.otHourlyRate);
  const gross = roundMoney(compensation.baseSalary + compensation.allowance + compensation.incentive + otPay);
  const totalDeduction = roundMoney(compensation.fixedDeduction + absenceDeduction + halfDayDeduction);
  const expectedWorkMinutes = attendance.expectedWorkMinutes;
  const fields = {
    user_id: userId,
    calculation_run_id: runId,
    salary_structure_id: structure?.legacyId ?? null,
    period_month: `${year}-${String(month).padStart(2, '0')}`,
    period_from: period.from,
    period_to: period.to,
    present_days: attendance.presentDays,
    half_days: attendance.halfDays,
    leave_days: attendance.leaveDays,
    unpaid_leave_days: 0,
    absent_days: attendance.absentDays,
    holiday_days: attendance.holidayDays,
    week_off_days: attendance.weekOffDays,
    work_minutes: attendance.workMinutes,
    regular_work_minutes: attendance.regularWorkMinutes,
    expected_work_minutes: expectedWorkMinutes,
    shortfall_minutes: Math.max(0, expectedWorkMinutes - attendance.regularWorkMinutes),
    working_hours_per_day: compensation.workingHoursPerDay,
    break_minutes: attendance.breakMinutes,
    late_minutes: attendance.lateMinutes,
    early_exit_minutes: attendance.earlyExitMinutes,
    approved_ot_minutes: attendance.overtimeMinutes,
    after_hours_ot_minutes: attendance.afterHoursOvertimeMinutes,
    weekend_ot_minutes: attendance.weekendOvertimeMinutes,
    holiday_ot_minutes: attendance.holidayOvertimeMinutes,
    manual_ot_minutes: attendance.manualOvertimeMinutes,
    monthly_salary: compensation.baseSalary,
    base_salary: compensation.baseSalary,
    daily_rate: roundMoney(dailyRate),
    ot_hourly_rate: compensation.otHourlyRate,
    fixed_allowance: compensation.allowance,
    fixed_incentive: compensation.incentive,
    ot_pay: otPay,
    gross_pay: gross,
    absence_deduction: absenceDeduction,
    half_day_deduction: halfDayDeduction,
    unpaid_leave_deduction: 0,
    fixed_deduction: compensation.fixedDeduction,
    total_deduction: totalDeduction,
    net_pay: roundMoney(gross - totalDeduction),
    salary_status: 'calculated',
    calculated_by: calculatedBy,
    calculated_at: nowIst(),
    updated_at: nowIst()
  };
  if (existing[0]) {
    const updated = await updateLegacyRecord('payroll_monthly', existing[0].legacyId!, fields);
    if (!updated) throw new HttpError(404, 'Payroll record could not be updated.');
    return updated;
  }
  return createLegacyRecord('payroll_monthly', { ...fields, created_at: nowIst() });
}

function compensationFor(structure: Record<string, unknown> | undefined, profile: Record<string, unknown>) {
  return {
    baseSalary: firstMoney(structure?.base_salary, profile.monthly_salary),
    allowance: firstMoney(structure?.allowances, profile.fixed_allowance),
    incentive: firstMoney(structure?.incentives, profile.fixed_incentive),
    fixedDeduction: firstMoney(structure?.deductions, profile.fixed_deduction),
    otHourlyRate: firstMoney(structure?.ot_hourly_rate, profile.ot_hourly_rate),
    workingHoursPerDay: firstPositive(structure?.working_hours_per_day, profile.working_hours_per_day, 8)
  };
}

function summarizeAttendance(
  logs: LegacyRecord[],
  leaves: LegacyRecord[],
  period: { from: string; to: string; days: number },
  workingHoursPerDay: number,
  holidayDates: Set<string>
) {
  const byDate = new Map(logs.map((log) => [String(log.raw.date), log.raw]));
  const leaveDates = new Set<string>();
  for (const leave of leaves) {
    for (const date of datesBetween(String(leave.raw.start_date), String(leave.raw.end_date))) {
      if (date >= period.from && date <= period.to) leaveDates.add(date);
    }
  }
  let presentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;
  let absentDays = 0;
  let weekOffDays = 0;
  let holidayDays = 0;
  let workMinutes = 0;
  let regularWorkMinutes = 0;
  let breakMinutes = 0;
  let lateMinutes = 0;
  let earlyExitMinutes = 0;
  let overtimeMinutes = 0;
  let afterHoursOvertimeMinutes = 0;
  let weekendOvertimeMinutes = 0;
  let holidayOvertimeMinutes = 0;
  let manualOvertimeMinutes = 0;
  const scheduledMinutes = Math.max(1, Math.round(workingHoursPerDay * 60));
  for (const date of datesBetween(period.from, period.to)) {
    const log = byDate.get(date);
    const dayWorkedMinutes = money(log?.total_minutes);
    const storedOvertimeMinutes = money(log?.overtime_minutes);
    const isHoliday = holidayDates.has(date);
    const isWeekendDay = isWeekend(date);
    const automaticOvertimeMinutes = isHoliday || isWeekendDay
      ? dayWorkedMinutes
      : Math.max(0, dayWorkedMinutes - scheduledMinutes);
    const approvedOvertimeMinutes = Math.max(automaticOvertimeMinutes, storedOvertimeMinutes);

    // Holidays take precedence where a public holiday falls on a weekend.
    // Neither kind of day is counted as an absence or expected work time.
    if (isHoliday) {
      holidayDays += 1;
      workMinutes += dayWorkedMinutes;
      breakMinutes += money(log?.break_minutes);
      lateMinutes += money(log?.late_minutes);
      earlyExitMinutes += money(log?.early_exit_minutes);
      overtimeMinutes += approvedOvertimeMinutes;
      holidayOvertimeMinutes += approvedOvertimeMinutes;
      continue;
    }
    if (isWeekendDay) {
      weekOffDays += 1;
      workMinutes += dayWorkedMinutes;
      breakMinutes += money(log?.break_minutes);
      lateMinutes += money(log?.late_minutes);
      earlyExitMinutes += money(log?.early_exit_minutes);
      overtimeMinutes += approvedOvertimeMinutes;
      weekendOvertimeMinutes += approvedOvertimeMinutes;
      continue;
    }

    const status = String(log?.status ?? '').trim().toLowerCase();
    if (leaveDates.has(date) || status === 'leave') leaveDays += 1;
    else if (status === 'half_day') halfDays += 1;
    else if (['present', 'completed', 'working'].includes(status)) presentDays += 1;
    else absentDays += 1;
    workMinutes += dayWorkedMinutes;
    regularWorkMinutes += Math.min(dayWorkedMinutes, scheduledMinutes);
    breakMinutes += money(log?.break_minutes);
    lateMinutes += money(log?.late_minutes);
    earlyExitMinutes += money(log?.early_exit_minutes);
    overtimeMinutes += approvedOvertimeMinutes;
    afterHoursOvertimeMinutes += approvedOvertimeMinutes;
    manualOvertimeMinutes += Math.max(0, approvedOvertimeMinutes - automaticOvertimeMinutes);
  }
  const expectedWorkMinutes = Math.max(0, Math.round((period.days - weekOffDays - holidayDays) * scheduledMinutes));
  return {
    presentDays,
    halfDays,
    leaveDays,
    absentDays,
    weekOffDays,
    holidayDays,
    workMinutes,
    regularWorkMinutes,
    expectedWorkMinutes,
    breakMinutes,
    lateMinutes,
    earlyExitMinutes,
    overtimeMinutes,
    afterHoursOvertimeMinutes,
    weekendOvertimeMinutes,
    holidayOvertimeMinutes,
    manualOvertimeMinutes
  };
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function selectEffectiveStructure(structures: LegacyRecord[], throughDate: string): LegacyRecord | null {
  const eligible = structures.filter((structure) => structureDate(structure) <= throughDate.slice(0, 10));
  return eligible.sort((left, right) => structureDate(right).localeCompare(structureDate(left)) || right.updatedAt.getTime() - left.updatedAt.getTime())[0] ?? null;
}

function structureDate(record: LegacyRecord): string {
  const value = String(record.raw.effective_from ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '0000-00-00';
}

async function requireEmployee(userId: number): Promise<LegacyRecord> {
  const employee = await findLegacyRecord('users', userId);
  if (!employee || !isActive(employee.raw.status)) throw new HttpError(404, 'Active employee not found.');
  return employee;
}

function requirePayrollView(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!canViewPayroll(req.auth)) {
    res.status(403).json({ error: 'Only authorised administrators or HR users can view payroll.' });
    return;
  }
  next();
}

function requirePayrollManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!canManagePayroll(req.auth)) {
    res.status(403).json({ error: 'Only administrators or HR users can manage salary and payroll.' });
    return;
  }
  next();
}

function monthPeriod(year: number, month: number) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), days: last.getUTCDate() };
}

function datesBetween(start: string, end: string): string[] {
  const output: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const final = new Date(`${end}T00:00:00Z`);
  while (!Number.isNaN(cursor.getTime()) && !Number.isNaN(final.getTime()) && cursor <= final) {
    output.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return output;
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

function money(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

function firstMoney(...values: unknown[]): number {
  for (const value of values) {
    const parsed = money(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundHours(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function employeeName(employee: LegacyRecord): string {
  return firstText(employee.raw.name, employee.raw.full_name, employee.raw.email, `Employee #${employee.legacyId}`);
}

function isActive(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return ['active', '1', 'true', 'enabled'].includes(String(value).trim().toLowerCase());
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { emitRealtime } from '../realtime.js';
import { archiveLegacyRecord, createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { notifyShiftStarted } from '../services/shiftStartNotifications.js';
import { canManageAttendance } from '../services/permissions.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const noteSchema = z.object({ reason: z.string().trim().min(2).max(2_000).optional().nullable() });
const workforceActionSchema = z.object({
  action: z.enum(['mark_present', 'mark_absent', 'end_shift']),
  note: z.string().trim().max(2_000).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const followUpSchema = z.object({
  message: z.string().trim().min(2).max(2_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});
const manualAttendanceSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD for the attendance date.'),
  status: z.enum(['present', 'half_day', 'absent', 'leave']),
  working_hours: z.coerce.number().min(0).max(24).default(0),
  break_minutes: z.coerce.number().int().min(0).max(720).default(0),
  overtime_minutes: z.coerce.number().int().min(0).max(1_440).default(0),
  check_in: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM for check-in time.').optional().nullable(),
  check_out: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM for check-out time.').optional().nullable(),
  note: z.string().trim().max(2_000).optional().nullable()
});
const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD for the holiday date.'),
  name: z.string().trim().min(2).max(160),
  note: z.string().trim().max(1_000).optional().nullable()
});

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

attendanceRouter.get('/me', asyncHandler(async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : todayIst();
  const userId = req.auth!.legacyId;
  const [shift, breaks, overtime, log] = await Promise.all([
    currentShift(userId, date),
    listRawRecords('attendance_breaks', { 'raw.user_id': userId, 'raw.work_date': date }, 100),
    listRawRecords('attendance_overtime', { 'raw.user_id': userId, 'raw.work_date': date }, 10),
    listRawRecords('attendance_logs', { 'raw.user_id': userId, 'raw.date': date }, 10)
  ]);
  const openBreak = breaks.find((entry) => !entry.raw.end_ist);
  const liveBreakMinutes = openBreak?.raw.start_ist ? minutesBetween(String(openBreak.raw.start_ist), nowIst()) : 0;
  const workedMinutes = shift?.raw.shift_start_ist && !shift.raw.shift_end_ist
    ? Math.max(0, minutesBetween(String(shift.raw.shift_start_ist), nowIst()) - number(shift.raw.break_minutes) - liveBreakMinutes)
    : number(log[0]?.raw.total_minutes ?? shift?.raw.total_minutes);
  const overtimePolicy = await calculateOvertimeForDate(userId, date, workedMinutes, number(log[0]?.raw.manual_overtime_minutes));
  res.json({
    date,
    shift: shift ? toPublicRecord(shift) : null,
    breaks: breaks.map(toPublicRecord),
    overtime: overtime.map(toPublicRecord),
    log: log[0] ? toPublicRecord(log[0]) : null,
    overtimePolicy
  });
}));

/** Public read-only calendar so employees can see why a date qualifies for
 * holiday overtime. HR/Admin users manage the entries below. */
attendanceRouter.get('/holidays', asyncHandler(async (req, res) => {
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year)
    ? Number(req.query.year)
    : Number(todayIst().slice(0, 4));
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new HttpError(400, 'Use a valid holiday year.');
  const records = await listRawRecords('attendance_holidays', {
    'raw.date': { $gte: `${year}-01-01`, $lte: `${year}-12-31` }
  }, 1_000);
  res.json({ data: records.sort((left, right) => String(left.raw.date).localeCompare(String(right.raw.date))).map(toPublicRecord) });
}));

attendanceRouter.post('/holidays', requireAttendanceManager, asyncHandler(async (req, res) => {
  const input = holidaySchema.parse(req.body);
  const existing = await listRawRecords('attendance_holidays', { 'raw.date': input.date }, 1);
  const fields = {
    date: input.date,
    name: input.name,
    note: input.note ?? null,
    updated_by: req.auth!.legacyId,
    updated_at: nowIst()
  };
  const record = existing[0]?.legacyId
    ? await updateLegacyRecord('attendance_holidays', existing[0].legacyId, fields)
    : await createLegacyRecord('attendance_holidays', { ...fields, created_by: req.auth!.legacyId, created_at: nowIst() });
  if (!record) throw new HttpError(404, 'Holiday could not be saved.');
  emitRealtime('attendance:holiday-changed', { date: input.date }, 'workforce');
  res.status(existing[0] ? 200 : 201).json({ data: toPublicRecord(record) });
}));

attendanceRouter.delete('/holidays/:holidayId', requireAttendanceManager, asyncHandler(async (req, res) => {
  const holidayId = numericId(req.params.holidayId);
  const holiday = await findLegacyRecord('attendance_holidays', holidayId);
  if (!holiday) throw new HttpError(404, 'Holiday not found.');
  const deleted = await archiveLegacyRecord('attendance_holidays', holidayId);
  if (!deleted) throw new HttpError(404, 'Holiday not found.');
  emitRealtime('attendance:holiday-changed', { date: String(holiday.raw.date ?? '') }, 'workforce');
  res.status(204).end();
}));

attendanceRouter.post('/clock-in', asyncHandler(async (req, res) => {
  const userId = req.auth!.legacyId;
  const date = todayIst();
  const existing = await currentShift(userId, date);
  if (existing?.raw.shift_start_ist) throw new HttpError(409, 'You have already started today’s shift.');
  const startedAt = nowIst();
  const shift = await createLegacyRecord('attendance_shifts', {
    user_id: userId,
    work_date: date,
    status: 'working',
    shift_start_ist: startedAt,
    shift_end_ist: null,
    total_minutes: 0,
    break_minutes: 0,
    overtime_minutes: 0,
    auto_overtime_minutes: 0,
    manual_overtime_minutes: 0,
    overtime_category: 'none',
    attendance_day_type: 'working_day',
    late_minutes: 0,
    early_exit_minutes: 0,
    source: 'web',
    created_at: startedAt,
    updated_at: startedAt
  });
  await createLegacyRecord('attendance_logs', {
    user_id: userId,
    date,
    status: 'present',
    attendance_type: 'full_day',
    source: 'web',
    shift_start_ist: startedAt,
    shift_end_ist: null,
    check_in: startedAt,
    check_out: null,
    total_minutes: 0,
    break_minutes: 0,
    late_minutes: 0,
    early_exit_minutes: 0,
    overtime_minutes: 0,
    auto_overtime_minutes: 0,
    manual_overtime_minutes: 0,
    overtime_category: 'none',
    attendance_day_type: 'working_day',
    created_at: startedAt,
    updated_at: startedAt
  });
  emitWorkforceChange(userId, date);
  try {
    await notifyShiftStarted({
      employeeId: userId,
      employeeName: req.auth!.name,
      shiftId: shift.legacyId ?? userId,
      workDate: date,
      startedAt
    });
  } catch (error) {
    // A failed alert must never make a successfully recorded attendance shift
    // look unsuccessful to the employee.
    console.error('[KAKI CRM] Shift-start notification delivery failed.', error);
  }
  res.status(201).json({ data: toPublicRecord(shift) });
}));

attendanceRouter.post('/breaks/start', asyncHandler(async (req, res) => {
  const shift = await requiredOpenShift(req.auth!.legacyId);
  const openBreak = await listRawRecords('attendance_breaks', { 'raw.shift_id': shift.legacyId, 'raw.end_ist': null }, 1);
  if (openBreak.length) throw new HttpError(409, 'End the current break before starting another one.');
  const record = await createLegacyRecord('attendance_breaks', {
    shift_id: shift.legacyId,
    user_id: req.auth!.legacyId,
    work_date: todayIst(),
    break_type: 'break',
    start_ist: nowIst(),
    end_ist: null,
    minutes: 0,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  emitWorkforceChange(req.auth!.legacyId, todayIst());
  res.status(201).json({ data: toPublicRecord(record) });
}));

attendanceRouter.post('/breaks/end', asyncHandler(async (req, res) => {
  const shift = await requiredOpenShift(req.auth!.legacyId);
  const [openBreak] = await listRawRecords('attendance_breaks', { 'raw.shift_id': shift.legacyId, 'raw.end_ist': null }, 1);
  if (!openBreak) throw new HttpError(409, 'There is no active break.');
  const endedAt = nowIst();
  const minutes = minutesBetween(String(openBreak.raw.start_ist), endedAt);
  const breakRecord = await updateLegacyRecord('attendance_breaks', openBreak.legacyId!, { end_ist: endedAt, minutes, updated_at: endedAt });
  const allBreaks = await listRawRecords('attendance_breaks', { 'raw.shift_id': shift.legacyId }, 100);
  const totalBreakMinutes = allBreaks.reduce((sum, item) => sum + number(item.raw.minutes), 0) + minutes;
  await updateLegacyRecord('attendance_shifts', shift.legacyId!, { break_minutes: totalBreakMinutes, updated_at: endedAt });
  await syncDailyLog(req.auth!.legacyId, todayIst(), { break_minutes: totalBreakMinutes, updated_at: endedAt });
  emitWorkforceChange(req.auth!.legacyId, todayIst());
  res.json({ data: breakRecord ? toPublicRecord(breakRecord) : null, totalBreakMinutes });
}));

attendanceRouter.post('/clock-out', asyncHandler(async (req, res) => {
  const input = noteSchema.parse(req.body);
  const shift = await requiredOpenShift(req.auth!.legacyId);
  const activeBreaks = await listRawRecords('attendance_breaks', { 'raw.shift_id': shift.legacyId, 'raw.end_ist': null }, 1);
  if (activeBreaks.length) throw new HttpError(409, 'End your current break before ending the shift.');
  const endedAt = nowIst();
  const totalMinutes = Math.max(0, minutesBetween(String(shift.raw.shift_start_ist), endedAt) - number(shift.raw.break_minutes));
  const status = totalMinutes >= 240 ? 'completed' : 'half_day';
  const overtime = await calculateOvertimeForDate(req.auth!.legacyId, todayIst(), totalMinutes);
  const updated = await updateLegacyRecord('attendance_shifts', shift.legacyId!, {
    status,
    shift_end_ist: endedAt,
    total_minutes: totalMinutes,
    overtime_minutes: overtime.overtimeMinutes,
    auto_overtime_minutes: overtime.automaticMinutes,
    manual_overtime_minutes: overtime.manualOverrideMinutes,
    overtime_category: overtime.category,
    attendance_day_type: overtime.dayType,
    notes: input.reason ?? shift.raw.notes ?? null,
    updated_at: endedAt
  });
  await syncDailyLog(req.auth!.legacyId, todayIst(), {
    status: status === 'half_day' ? 'half_day' : 'present',
    attendance_type: status === 'half_day' ? 'half_day' : 'full_day',
    shift_end_ist: endedAt,
    check_out: endedAt,
    total_minutes: totalMinutes,
    overtime_minutes: overtime.overtimeMinutes,
    auto_overtime_minutes: overtime.automaticMinutes,
    manual_overtime_minutes: overtime.manualOverrideMinutes,
    overtime_category: overtime.category,
    attendance_day_type: overtime.dayType,
    notes: input.reason ?? null,
    updated_at: endedAt
  });
  await recordCalculatedOvertime(req.auth!.legacyId, todayIst(), totalMinutes, overtime, req.auth!.legacyId);
  emitWorkforceChange(req.auth!.legacyId, todayIst());
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

attendanceRouter.post('/overtime/request', asyncHandler(async (req, res) => {
  const input = z.object({ reason: z.string().trim().min(2).max(2_000), requested_end_at: z.string().max(30).optional().nullable() }).parse(req.body);
  const record = await createLegacyRecord('attendance_overtime', {
    user_id: req.auth!.legacyId,
    work_date: todayIst(),
    status: 'requested_start',
    start_reason: input.reason,
    requested_start_at: nowIst(),
    requested_end_at: input.requested_end_at ?? null,
    ot_minutes: 0,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  emitWorkforceChange(req.auth!.legacyId, todayIst());
  res.status(201).json({ data: toPublicRecord(record) });
}));

attendanceRouter.get('/overview', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const date = requestDate(req.query.date);
  const [shifts, leaves, users, overtime] = await Promise.all([
    listRawRecords('attendance_shifts', { 'raw.work_date': date }, 1_000),
    listRawRecords('leave_requests', { 'raw.start_date': { $lte: date }, 'raw.end_date': { $gte: date }, 'raw.status': 'approved' }, 1_000),
    listRawRecords('users', { 'raw.status': 'active' }, 1_000),
    listRawRecords('attendance_overtime', { 'raw.work_date': date }, 1_000)
  ]);
  res.json({
    date,
    totals: {
      activeEmployees: users.length,
      checkedIn: shifts.filter((shift) => Boolean(shift.raw.shift_start_ist)).length,
      completed: shifts.filter((shift) => Boolean(shift.raw.shift_end_ist)).length,
      onLeave: leaves.length,
      overtimeRequests: overtime.filter((item) => String(item.raw.status).startsWith('requested')).length
    },
    shifts: shifts.map(toPublicRecord)
  });
}));

attendanceRouter.get('/employees', requireAttendanceManager, asyncHandler(async (_req, res) => {
  const users = await listRawRecords('users', {}, 2_000);
  res.json({
    data: users
      .filter((user) => isActiveEmployee(user.raw.status))
      .map((user) => ({ id: user.legacyId, label: String(user.raw.name ?? user.raw.full_name ?? user.raw.email ?? `Employee #${user.legacyId}`), department: user.raw.department ?? null, designation: user.raw.designation ?? null }))
      .filter((user) => Number.isSafeInteger(user.id) && Number(user.id) > 0)
      .sort((left, right) => left.label.localeCompare(right.label))
  });
}));

// HR/Admin can correct historic attendance or record working hours for an
// employee who did not use self-service clock-in. The daily log is the
// payroll source of truth, and the linked shift stays in sync for workforce
// screens and auditability.
attendanceRouter.put('/manual/:userId', requireAttendanceManager, asyncHandler(async (req, res) => {
  const userId = numericId(req.params.userId);
  const input = manualAttendanceSchema.parse(req.body);
  const user = await findLegacyRecord('users', userId);
  if (!user || !isActiveEmployee(user.raw.status)) throw new HttpError(404, 'Active employee not found.');
  const recordedAt = nowIst();
  const workMinutes = input.status === 'absent' || input.status === 'leave' ? 0 : Math.max(0, Math.round(input.working_hours * 60));
  const overtime = await calculateOvertimeForDate(userId, input.date, workMinutes, input.overtime_minutes);
  const checkIn = input.status === 'present' || input.status === 'half_day' ? dateTimeFor(input.date, input.check_in) : null;
  const checkOut = input.status === 'present' || input.status === 'half_day' ? dateTimeFor(input.date, input.check_out) : null;
  const dailyStatus = input.status;
  const attendanceType = input.status === 'present' ? 'full_day' : input.status;
  const shiftStatus = input.status === 'present' ? 'completed' : input.status;
  const fields = {
    status: dailyStatus,
    attendance_type: attendanceType,
    source: 'hr_manual',
    shift_start_ist: checkIn,
    shift_end_ist: checkOut,
    check_in: checkIn,
    check_out: checkOut,
    total_minutes: workMinutes,
    break_minutes: input.break_minutes,
    overtime_minutes: overtime.overtimeMinutes,
    auto_overtime_minutes: overtime.automaticMinutes,
    manual_overtime_minutes: overtime.manualOverrideMinutes,
    overtime_category: overtime.category,
    attendance_day_type: overtime.dayType,
    notes: input.note ?? null,
    manual_by: req.auth!.legacyId,
    manual_recorded_at: recordedAt,
    updated_at: recordedAt
  };
  const log = await upsertDailyLog(userId, input.date, fields);
  const shift = await currentShift(userId, input.date);
  const shiftFields = {
    user_id: userId,
    work_date: input.date,
    status: shiftStatus,
    shift_start_ist: checkIn,
    shift_end_ist: checkOut,
    total_minutes: workMinutes,
    break_minutes: input.break_minutes,
    overtime_minutes: overtime.overtimeMinutes,
    auto_overtime_minutes: overtime.automaticMinutes,
    manual_overtime_minutes: overtime.manualOverrideMinutes,
    overtime_category: overtime.category,
    attendance_day_type: overtime.dayType,
    late_minutes: 0,
    early_exit_minutes: 0,
    source: 'hr_manual',
    notes: input.note ?? null,
    manual_by: req.auth!.legacyId,
    manual_recorded_at: recordedAt,
    updated_at: recordedAt
  };
  const savedShift = shift?.legacyId
    ? await updateLegacyRecord('attendance_shifts', shift.legacyId, shiftFields)
    : await createLegacyRecord('attendance_shifts', { ...shiftFields, created_at: recordedAt });
  await recordCalculatedOvertime(userId, input.date, workMinutes, overtime, req.auth!.legacyId);
  emitWorkforceChange(userId, input.date);
  res.json({ data: toPublicRecord(log), shift: savedShift ? toPublicRecord(savedShift) : null });
}));

attendanceRouter.get('/workforce', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const date = requestDate(req.query.date);
  res.json(await buildWorkforceSnapshot(date));
}));

attendanceRouter.patch('/workforce/:userId/attendance', requirePermission('attendance.manage'), asyncHandler(async (req, res) => {
  const userId = numericId(req.params.userId);
  const input = workforceActionSchema.parse(req.body);
  const date = input.date ?? todayIst();
  if (date !== todayIst()) throw new HttpError(400, 'Live attendance actions are available for today only.');

  const user = await findLegacyRecord('users', userId);
  if (!user || String(user.raw.status ?? 'active').toLowerCase() !== 'active') throw new HttpError(404, 'Active employee not found.');

  const recordedAt = nowIst();
  let record: LegacyRecord | null = null;

  if (input.action === 'mark_present') {
    const existing = await currentShift(userId, date);
    if (existing?.raw.shift_start_ist && !existing.raw.shift_end_ist) {
      record = existing;
    } else if (existing) {
      record = await updateLegacyRecord('attendance_shifts', existing.legacyId!, {
        status: 'working',
        shift_start_ist: recordedAt,
        shift_end_ist: null,
        total_minutes: 0,
        break_minutes: 0,
        source: 'hr_manual',
        notes: input.note ?? existing.raw.notes ?? null,
        updated_at: recordedAt
      });
    } else {
      record = await createLegacyRecord('attendance_shifts', {
        user_id: userId,
        work_date: date,
        status: 'working',
        shift_start_ist: recordedAt,
        shift_end_ist: null,
        total_minutes: 0,
        break_minutes: 0,
        late_minutes: 0,
        early_exit_minutes: 0,
        source: 'hr_manual',
        notes: input.note ?? null,
        created_at: recordedAt,
        updated_at: recordedAt
      });
    }
    await upsertDailyLog(userId, date, {
      status: 'present',
      attendance_type: 'full_day',
      source: 'hr_manual',
      shift_start_ist: recordedAt,
      shift_end_ist: null,
      check_in: recordedAt,
      check_out: null,
      total_minutes: 0,
      break_minutes: 0,
      notes: input.note ?? null,
      updated_at: recordedAt
    });
  }

  if (input.action === 'mark_absent') {
    const existingShift = await currentShift(userId, date);
    if (existingShift?.raw.shift_start_ist) throw new HttpError(409, 'An employee with a recorded shift cannot be marked absent.');
    record = await upsertDailyLog(userId, date, {
      status: 'absent',
      attendance_type: 'absent',
      source: 'hr_manual',
      shift_start_ist: null,
      shift_end_ist: null,
      check_in: null,
      check_out: null,
      total_minutes: 0,
      break_minutes: 0,
      notes: input.note ?? null,
      updated_at: recordedAt
    });
  }

  if (input.action === 'end_shift') {
    const shift = await currentShift(userId, date);
    if (!shift?.raw.shift_start_ist || shift.raw.shift_end_ist) throw new HttpError(409, 'There is no live shift to end.');
    const activeBreaks = await listRawRecords('attendance_breaks', { 'raw.shift_id': shift.legacyId, 'raw.end_ist': null }, 1);
    if (activeBreaks.length) throw new HttpError(409, 'End the employee’s active break before ending the shift.');
    const totalMinutes = Math.max(0, minutesBetween(String(shift.raw.shift_start_ist), recordedAt) - number(shift.raw.break_minutes));
    const status = totalMinutes >= 240 ? 'completed' : 'half_day';
    const overtime = await calculateOvertimeForDate(userId, date, totalMinutes);
    record = await updateLegacyRecord('attendance_shifts', shift.legacyId!, {
      status,
      shift_end_ist: recordedAt,
      total_minutes: totalMinutes,
      overtime_minutes: overtime.overtimeMinutes,
      auto_overtime_minutes: overtime.automaticMinutes,
      manual_overtime_minutes: overtime.manualOverrideMinutes,
      overtime_category: overtime.category,
      attendance_day_type: overtime.dayType,
      notes: input.note ?? shift.raw.notes ?? null,
      updated_at: recordedAt
    });
    await upsertDailyLog(userId, date, {
      status: status === 'half_day' ? 'half_day' : 'present',
      attendance_type: status === 'half_day' ? 'half_day' : 'full_day',
      source: 'hr_manual',
      shift_end_ist: recordedAt,
      check_out: recordedAt,
      total_minutes: totalMinutes,
      overtime_minutes: overtime.overtimeMinutes,
      auto_overtime_minutes: overtime.automaticMinutes,
      manual_overtime_minutes: overtime.manualOverrideMinutes,
      overtime_category: overtime.category,
      attendance_day_type: overtime.dayType,
      notes: input.note ?? null,
      updated_at: recordedAt
    });
    await recordCalculatedOvertime(userId, date, totalMinutes, overtime, req.auth!.legacyId);
  }

  emitWorkforceChange(userId, date);
  res.json({ data: record ? toPublicRecord(record) : null });
}));

attendanceRouter.post('/workforce/:userId/follow-up', requirePermission('attendance.manage'), asyncHandler(async (req, res) => {
  const userId = numericId(req.params.userId);
  const input = followUpSchema.parse(req.body);
  const date = input.date ?? todayIst();
  const user = await findLegacyRecord('users', userId);
  if (!user || String(user.raw.status ?? 'active').toLowerCase() !== 'active') throw new HttpError(404, 'Active employee not found.');

  const notification = await createLegacyRecord('notifications', {
    user_id: userId,
    actor_id: req.auth!.legacyId,
    type: 'workflow.follow_up',
    title: 'Daily workflow follow-up',
    body: input.message,
    url: '/tasks',
    entity_type: 'workforce',
    entity_id: userId,
    meta: JSON.stringify({ date, source: 'live_workforce' }),
    is_read: 0,
    created_at: nowIst()
  });
  emitRealtime('notification:new', { notification: toPublicRecord(notification) }, `user:${userId}`);
  emitRealtime('workflow:follow-up', { userId, date }, 'workforce');
  res.status(201).json({ data: toPublicRecord(notification) });
}));

attendanceRouter.patch('/overtime/:overtimeId/review', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const input = z.object({ approved: z.boolean(), note: z.string().max(2_000).optional().nullable() }).parse(req.body);
  const record = await findLegacyRecord('attendance_overtime', numericId(req.params.overtimeId));
  if (!record) throw new HttpError(404, 'Overtime request not found.');
  const status = input.approved ? 'start_approved' : 'start_rejected';
  const updated = await updateLegacyRecord('attendance_overtime', record.legacyId!, {
    status,
    hr_note: input.note ?? null,
    start_approved_by: req.auth!.legacyId,
    start_approved_at: nowIst(),
    updated_at: nowIst()
  });
  emitWorkforceChange(Number(record.raw.user_id), String(record.raw.work_date ?? todayIst()));
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

async function requiredOpenShift(userId: number): Promise<LegacyRecord> {
  const shift = await currentShift(userId, todayIst());
  if (!shift?.raw.shift_start_ist || shift.raw.shift_end_ist) throw new HttpError(409, 'Start your shift first.');
  return shift;
}

function requireAttendanceManager(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!canManageAttendance(req.auth)) {
    res.status(403).json({ error: 'Only administrators or HR users can record attendance for employees.' });
    return;
  }
  next();
}

async function currentShift(userId: number, date: string): Promise<LegacyRecord | null> {
  const rows = await listRawRecords('attendance_shifts', { 'raw.user_id': userId, 'raw.work_date': date }, 10);
  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
}

async function syncDailyLog(userId: number, date: string, patch: Record<string, unknown>): Promise<void> {
  const [log] = await listRawRecords('attendance_logs', { 'raw.user_id': userId, 'raw.date': date }, 1);
  if (log) await updateLegacyRecord('attendance_logs', log.legacyId!, patch);
}

async function upsertDailyLog(userId: number, date: string, patch: Record<string, unknown>): Promise<LegacyRecord> {
  const [log] = await listRawRecords('attendance_logs', { 'raw.user_id': userId, 'raw.date': date }, 1);
  if (log) {
    const updated = await updateLegacyRecord('attendance_logs', log.legacyId!, patch);
    if (updated) return updated;
  }
  const recordedAt = nowIst();
  return createLegacyRecord('attendance_logs', {
    user_id: userId,
    date,
    status: 'present',
    attendance_type: 'full_day',
    source: 'hr_manual',
    shift_start_ist: null,
    shift_end_ist: null,
    check_in: null,
    check_out: null,
    total_minutes: 0,
    break_minutes: 0,
    late_minutes: 0,
    early_exit_minutes: 0,
    overtime_minutes: 0,
    auto_overtime_minutes: 0,
    manual_overtime_minutes: 0,
    overtime_category: 'none',
    attendance_day_type: 'working_day',
    created_at: recordedAt,
    updated_at: recordedAt,
    ...patch
  });
}

type OvertimeCategory = 'after_hours' | 'weekend' | 'holiday' | 'manual' | 'none';
type AttendanceDayType = 'working_day' | 'weekend' | 'holiday';

interface OvertimeCalculation {
  dayType: AttendanceDayType;
  category: OvertimeCategory;
  holidayName: string | null;
  scheduledMinutes: number;
  workedMinutes: number;
  automaticMinutes: number;
  manualOverrideMinutes: number;
  overtimeMinutes: number;
}

/**
 * Calculates paid overtime from the employee's effective salary structure.
 * Normal workdays earn overtime only after the configured daily target.
 * Saturday/Sunday and an HR-defined holiday earn overtime for every worked
 * minute. The manual value is treated as an HR-approved floor, never as a
 * way to erase automatic overtime already earned.
 */
async function calculateOvertimeForDate(userId: number, date: string, rawWorkedMinutes: number, rawManualMinutes = 0): Promise<OvertimeCalculation> {
  const [structures, profiles, holidays] = await Promise.all([
    listRawRecords('salary_structures', { 'raw.user_id': userId, 'raw.is_active': { $ne: 0 } }, 100),
    listRawRecords('salary_profiles', { 'raw.user_id': userId, 'raw.is_active': { $ne: 0 } }, 20),
    listRawRecords('attendance_holidays', { 'raw.date': date }, 1)
  ]);
  const structure = selectEffectiveAttendanceStructure(structures, date);
  const profile = profiles.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
  const scheduledMinutes = Math.max(1, Math.round(firstPositive(structure?.raw.working_hours_per_day, profile?.raw.working_hours_per_day, 8) * 60));
  const workedMinutes = Math.max(0, Math.round(rawWorkedMinutes));
  const holiday = holidays[0];
  const dayType: AttendanceDayType = holiday ? 'holiday' : isWeekend(date) ? 'weekend' : 'working_day';
  const automaticMinutes = dayType === 'working_day'
    ? Math.max(0, workedMinutes - scheduledMinutes)
    : workedMinutes;
  const requestedManualMinutes = Math.min(workedMinutes, Math.max(0, Math.round(rawManualMinutes)));
  const overtimeMinutes = Math.max(automaticMinutes, requestedManualMinutes);
  const manualOverrideMinutes = Math.max(0, overtimeMinutes - automaticMinutes);
  const category: OvertimeCategory = dayType === 'holiday'
    ? 'holiday'
    : dayType === 'weekend'
      ? 'weekend'
      : automaticMinutes > 0
        ? 'after_hours'
        : manualOverrideMinutes > 0
          ? 'manual'
          : 'none';
  return {
    dayType,
    category,
    holidayName: holiday ? textOrNull(holiday.raw.name) : null,
    scheduledMinutes,
    workedMinutes,
    automaticMinutes,
    manualOverrideMinutes,
    overtimeMinutes
  };
}

async function recordCalculatedOvertime(userId: number, date: string, workedMinutes: number, overtime: OvertimeCalculation, recordedBy: number): Promise<void> {
  const existing = await listRawRecords('attendance_overtime', {
    'raw.user_id': userId,
    'raw.work_date': date,
    'raw.source': 'automatic'
  }, 1);
  const savedAt = nowIst();
  const fields = {
    user_id: userId,
    work_date: date,
    source: 'automatic',
    status: overtime.overtimeMinutes > 0 ? 'system_approved' : 'not_eligible',
    ot_minutes: overtime.overtimeMinutes,
    auto_ot_minutes: overtime.automaticMinutes,
    manual_ot_minutes: overtime.manualOverrideMinutes,
    category: overtime.category,
    day_type: overtime.dayType,
    holiday_name: overtime.holidayName,
    scheduled_minutes: overtime.scheduledMinutes,
    worked_minutes: workedMinutes,
    calculated_by: recordedBy,
    calculated_at: savedAt,
    updated_at: savedAt
  };
  if (existing[0]?.legacyId) {
    await updateLegacyRecord('attendance_overtime', existing[0].legacyId, fields);
  } else if (overtime.overtimeMinutes > 0) {
    await createLegacyRecord('attendance_overtime', { ...fields, created_at: savedAt });
  }
}

function selectEffectiveAttendanceStructure(structures: LegacyRecord[], date: string): LegacyRecord | null {
  return structures
    .filter((structure) => attendanceStructureDate(structure) <= date)
    .sort((left, right) => attendanceStructureDate(right).localeCompare(attendanceStructureDate(left)) || right.updatedAt.getTime() - left.updatedAt.getTime())[0] ?? null;
}

function attendanceStructureDate(record: LegacyRecord): string {
  const date = String(record.raw.effective_from ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '0000-00-00';
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function isWeekend(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

async function buildWorkforceSnapshot(date: string): Promise<Record<string, unknown>> {
  const generatedAt = nowIst();
  const [users, shifts, logs, breaks, leaves, tasks, dailyCheckins, taskUpdates, overtime] = await Promise.all([
    listRawRecords('users', { 'raw.status': 'active' }, 2_000),
    listRawRecords('attendance_shifts', { 'raw.work_date': date }, 5_000),
    listRawRecords('attendance_logs', { 'raw.date': date }, 5_000),
    listRawRecords('attendance_breaks', { 'raw.work_date': date }, 5_000),
    listRawRecords('leave_requests', { 'raw.start_date': { $lte: date }, 'raw.end_date': { $gte: date }, 'raw.status': 'approved' }, 5_000),
    listRawRecords('tasks', {}, 10_000),
    listRawRecords('daily_checkins', { 'raw.checkin_date': date }, 5_000),
    listRawRecords('task_updates', { 'raw.update_date': date }, 10_000),
    listRawRecords('attendance_overtime', { 'raw.work_date': date }, 5_000)
  ]);

  const shiftsByUser = latestByUser(shifts);
  const logsByUser = latestByUser(logs);
  const activeBreaksByUser = latestByUser(breaks.filter((entry) => !entry.raw.end_ist));
  const leaveUserIds = new Set(leaves.map((entry) => positiveInteger(entry.raw.user_id)).filter((value): value is number => value !== null));
  const tasksByUser = groupByTaskAssignees(tasks);
  const checkinsByUser = latestByUser(dailyCheckins);
  const updatesByUser = groupByUser(taskUpdates, 'user_id');
  const overtimeByUser = latestByUser(overtime);

  const people = users
    .map((user) => makeWorkforcePerson(user, {
      date,
      generatedAt,
      shift: shiftsByUser.get(legacyIdOf(user) ?? -1),
      log: logsByUser.get(legacyIdOf(user) ?? -1),
      activeBreak: activeBreaksByUser.get(legacyIdOf(user) ?? -1),
      onLeave: leaveUserIds.has(legacyIdOf(user) ?? -1),
      tasks: tasksByUser.get(legacyIdOf(user) ?? -1) ?? [],
      checkin: checkinsByUser.get(legacyIdOf(user) ?? -1),
      updates: updatesByUser.get(legacyIdOf(user) ?? -1) ?? [],
      overtime: overtimeByUser.get(legacyIdOf(user) ?? -1)
    }))
    .filter((person): person is WorkforcePerson => person !== null)
    .sort((left, right) => workforceSort(left, right));

  return {
    date,
    generatedAt,
    totals: {
      activeEmployees: people.length,
      checkedIn: people.filter((person) => ['working', 'on_break', 'completed', 'half_day', 'present'].includes(person.attendance.state)).length,
      working: people.filter((person) => person.attendance.state === 'working').length,
      onBreak: people.filter((person) => person.attendance.state === 'on_break').length,
      completed: people.filter((person) => ['completed', 'half_day'].includes(person.attendance.state)).length,
      onLeave: people.filter((person) => person.attendance.state === 'on_leave').length,
      absent: people.filter((person) => ['absent', 'not_started'].includes(person.attendance.state)).length,
      activeTasks: people.reduce((sum, person) => sum + person.workflow.openTasks, 0),
      overdueTasks: people.reduce((sum, person) => sum + person.workflow.overdueTasks, 0)
    },
    people
  };
}

interface WorkforcePerson {
  user: { id: number; name: string; email: string; department: string; designation: string };
  attendance: {
    state: 'working' | 'on_break' | 'completed' | 'half_day' | 'on_leave' | 'present' | 'absent' | 'not_started';
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

function makeWorkforcePerson(user: LegacyRecord, context: {
  date: string;
  generatedAt: string;
  shift?: LegacyRecord;
  log?: LegacyRecord;
  activeBreak?: LegacyRecord;
  onLeave: boolean;
  tasks: LegacyRecord[];
  checkin?: LegacyRecord;
  updates: LegacyRecord[];
  overtime?: LegacyRecord;
}): WorkforcePerson | null {
  const userId = legacyIdOf(user);
  if (!userId) return null;
  const { shift, log, activeBreak } = context;
  const checkIn = textOrNull(shift?.raw.shift_start_ist ?? log?.raw.shift_start_ist ?? log?.raw.check_in);
  const checkOut = textOrNull(shift?.raw.shift_end_ist ?? log?.raw.shift_end_ist ?? log?.raw.check_out);
  const currentBreakMinutes = activeBreak?.raw.start_ist ? minutesBetween(String(activeBreak.raw.start_ist), context.generatedAt) : 0;
  const breakMinutes = number(shift?.raw.break_minutes ?? log?.raw.break_minutes) + currentBreakMinutes;
  const totalMinutes = checkIn && !checkOut
    ? Math.max(0, minutesBetween(checkIn, context.generatedAt) - breakMinutes)
    : number(shift?.raw.total_minutes ?? log?.raw.total_minutes);
  const attendanceStatus = String(shift?.raw.status ?? log?.raw.status ?? '').toLowerCase();
  const state = checkIn && !checkOut
    ? activeBreak ? 'on_break' : 'working'
    : checkOut ? attendanceStatus === 'half_day' ? 'half_day' : 'completed'
      : context.onLeave ? 'on_leave'
        : attendanceStatus === 'leave' ? 'on_leave'
        : attendanceStatus === 'absent' ? 'absent'
          : attendanceStatus === 'half_day' ? 'half_day'
            : attendanceStatus === 'present' ? 'present'
              : 'not_started';
  const completedTasks = context.tasks.filter((task) => completedTask(task.raw.status)).length;
  const openTasks = context.tasks.filter((task) => openTask(task.raw.status)).length;
  const overdueTasks = context.tasks.filter((task) => openTask(task.raw.status) && dateBefore(task.raw.due_date, context.date)).length;
  const activeTaskTitles = context.tasks
    .filter((task) => openTask(task.raw.status))
    .map((task) => textOrNull(task.raw.title))
    .filter((title): title is string => Boolean(title))
    .slice(0, 3);
  const latestUpdate = context.updates.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];

  return {
    user: {
      id: userId,
      name: textOrNull(user.raw.name) ?? 'Unnamed employee',
      email: textOrNull(user.raw.email) ?? '',
      department: textOrNull(user.raw.department) ?? 'Unassigned department',
      designation: textOrNull(user.raw.designation) ?? 'Team member'
    },
    attendance: {
      state,
      shiftId: shift?.legacyId ?? null,
      checkIn,
      checkOut,
      totalMinutes,
      breakMinutes,
      source: textOrNull(shift?.raw.source ?? log?.raw.source)
    },
    workflow: {
      totalTasks: context.tasks.length,
      openTasks,
      completedTasks,
      overdueTasks,
      activeTaskTitles,
      updatesToday: context.updates.length,
      lastUpdateAt: latestUpdate ? textOrNull(latestUpdate.raw.created_at) ?? latestUpdate.createdAt.toISOString() : null,
      dailyCheckin: context.checkin ? {
        plan: textOrNull(context.checkin.raw.today_plan ?? context.checkin.raw.daily_plan ?? context.checkin.raw.plan) ?? '',
        priorities: textOrNull(context.checkin.raw.priorities ?? context.checkin.raw.priority) ?? '',
        blockers: textOrNull(context.checkin.raw.blockers ?? context.checkin.raw.blocker) ?? ''
      } : null
    },
    overtime: context.overtime ? {
      status: textOrNull(context.overtime.raw.status) ?? 'requested',
      minutes: number(context.overtime.raw.ot_minutes)
    } : null
  };
}

function latestByUser(records: LegacyRecord[]): Map<number, LegacyRecord> {
  const results = new Map<number, LegacyRecord>();
  for (const record of records) {
    const userId = positiveInteger(record.raw.user_id);
    if (!userId) continue;
    const existing = results.get(userId);
    if (!existing || record.updatedAt.getTime() > existing.updatedAt.getTime()) results.set(userId, record);
  }
  return results;
}

function groupByUser(records: LegacyRecord[], userField: string): Map<number, LegacyRecord[]> {
  const results = new Map<number, LegacyRecord[]>();
  for (const record of records) {
    const values = Array.isArray(record.raw[userField]) ? record.raw[userField] : [record.raw[userField]];
    for (const value of values) {
      const userId = positiveInteger(value);
      if (!userId) continue;
      const current = results.get(userId) ?? [];
      current.push(record);
      results.set(userId, current);
    }
  }
  return results;
}

function groupByTaskAssignees(records: LegacyRecord[]): Map<number, LegacyRecord[]> {
  const results = new Map<number, LegacyRecord[]>();
  for (const record of records) {
    const values = [
      ...(Array.isArray(record.raw.assignee_ids) ? record.raw.assignee_ids : []),
      record.raw.assignee_id
    ];
    const userIds = [...new Set(values.map(positiveInteger).filter((value): value is number => value !== null))];
    for (const userId of userIds) {
      const current = results.get(userId) ?? [];
      current.push(record);
      results.set(userId, current);
    }
  }
  return results;
}

function workforceSort(left: WorkforcePerson, right: WorkforcePerson): number {
  const order = ['working', 'on_break', 'present', 'completed', 'half_day', 'on_leave', 'not_started', 'absent'];
  const stateDifference = order.indexOf(left.attendance.state) - order.indexOf(right.attendance.state);
  return stateDifference || left.user.name.localeCompare(right.user.name);
}

function completedTask(value: unknown): boolean {
  return ['completed', 'complete', 'done'].includes(String(value ?? '').toLowerCase());
}

function openTask(value: unknown): boolean {
  const status = String(value ?? '').toLowerCase();
  return !completedTask(status) && !['cancelled', 'canceled', 'archived'].includes(status);
}

function dateBefore(value: unknown, date: string): boolean {
  const due = textOrNull(value)?.slice(0, 10);
  return Boolean(due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < date);
}

function legacyIdOf(record: LegacyRecord): number | null {
  return positiveInteger(record.legacyId ?? record.raw.id);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function requestDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return todayIst();
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(value);
}

function emitWorkforceChange(userId: number, date: string): void {
  if (Number.isSafeInteger(userId) && userId > 0) emitRealtime('attendance:changed', { userId, date }, 'workforce');
}

function numericId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid record ID.');
  return parsed;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isActiveEmployee(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return ['active', '1', 'true', 'enabled'].includes(String(value).trim().toLowerCase());
}

function minutesBetween(from: string, to: string): number {
  const start = new Date(`${from.replace(' ', 'T')}+05:30`).getTime();
  const end = new Date(`${to.replace(' ', 'T')}+05:30`).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 60_000)) : 0;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function dateTimeFor(date: string, time: string | null | undefined): string | null {
  return time ? `${date} ${time}:00` : null;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

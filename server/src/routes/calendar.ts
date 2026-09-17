import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { type AuthContext, can, isAdminOrHrRole, isCeoRole, isEmployeeRole } from '../services/permissions.js';
import { archiveLegacyRecord, createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecord } from '../db/legacy.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const calendarTypes = ['holiday', 'restricted_holiday', 'meeting', 'company_event', 'milestone', 'deadline', 'task', 'shift', 'leave', 'work_from_home', 'business_travel', 'payroll', 'salary', 'invoice', 'payment', 'client_followup', 'training', 'onboarding', 'performance_review', 'department', 'birthday', 'anniversary', 'compliance', 'recruitment', 'recurring', 'custom'] as const;
const eventSchemaBase = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(10_000).optional().nullable(),
  type: z.enum(calendarTypes).default('custom'),
  status: z.string().trim().max(60).default('planned'),
  start: z.string().trim().min(1).max(80),
  end: z.string().trim().min(1).max(80),
  allDay: z.boolean().default(false),
  departmentId: z.coerce.number().int().positive().optional().nullable(),
  employeeIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  projectId: z.coerce.number().int().positive().optional().nullable(),
  location: z.string().trim().max(500).optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  visibility: z.enum(['company', 'department', 'permitted', 'personal']).default('company'),
  reminderChannels: z.array(z.enum(['email', 'whatsapp', 'in_app', 'clara'])).max(4).default(['in_app']),
  reminderMinutes: z.array(z.coerce.number().int().min(0).max(10080)).max(10).default([30]),
  recurrence: z.string().trim().max(255).optional().nullable(),
  attachmentIds: z.array(z.coerce.number().int().positive()).max(50).default([]),
  notes: z.string().trim().max(10_000).optional().nullable()
});
const eventSchema = eventSchemaBase.superRefine((value, ctx) => {
  const start = new Date(value.start).valueOf(); const end = new Date(value.end).valueOf();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'End time must be later than start time.' });
});

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

calendarRouter.get('/', requireCalendarRead, asyncHandler(async (req, res) => {
  const events = await collectCalendarEvents(req.auth!, {
    from: dateQuery(req.query.from) ?? monthStart(),
    to: dateQuery(req.query.to) ?? monthEnd(),
    type: stringQuery(req.query.type),
    status: stringQuery(req.query.status),
    departmentId: positive(req.query.departmentId),
    employeeId: positive(req.query.employeeId),
    projectId: positive(req.query.projectId),
    search: stringQuery(req.query.search)
  });
  const page = numberQuery(req.query.page, 1); const limit = Math.min(100, numberQuery(req.query.limit, 50));
  const start = (page - 1) * limit; const pages = Math.max(1, Math.ceil(events.length / limit));
  res.json({ data: events.slice(start, start + limit), pagination: { page, limit, total: events.length, pages } });
}));

calendarRouter.post('/events', requireCalendarManage, asyncHandler(async (req, res) => {
  const input = eventSchema.parse(req.body);
  const actor = req.auth!;
  const employeeIds = [...new Set(input.employeeIds)];
  if (isEmployeeRole(actor)) {
    if (input.visibility !== 'personal' && input.visibility !== 'permitted') throw new HttpError(403, 'Employees can create only personal or permitted calendar entries.');
    if (employeeIds.some((id) => id !== actor.legacyId)) throw new HttpError(403, 'Employees can add only themselves to a personal calendar entry.');
  }
  const conflict = await findConflict(String(input.start), String(input.end), employeeIds, input.location ?? undefined);
  if (conflict) throw new HttpError(409, `Calendar conflict with “${conflict.title}”.`);
  const now = nowIso();
  const event = await createLegacyRecord('calendar_events', {
    title: input.title, description: input.description ?? '', type: input.type, status: input.status,
    start_at: new Date(input.start).toISOString(), end_at: new Date(input.end).toISOString(), all_day: input.allDay,
    department_id: input.departmentId ?? null, employee_ids: employeeIds.length ? employeeIds : [actor.legacyId], project_id: input.projectId ?? null,
    location: input.location ?? null, priority: input.priority, visibility: input.visibility, reminder_channels: input.reminderChannels,
    reminder_minutes: input.reminderMinutes, recurrence: input.recurrence ?? null, attachment_ids: input.attachmentIds, notes: input.notes ?? '', owner_id: actor.legacyId,
    created_by: actor.legacyId, created_at: now, updated_at: now, change_history: [{ action: 'created', by: actor.legacyId, at: now }]
  });
  await notifyCalendarEmployees(event.legacyId!, employeeIds, actor);
  emitRealtime('calendar:changed', { action: 'created', event: toPublicRecord(event) }, 'workforce');
  res.status(201).json({ data: toPublicRecord(event) });
}));

calendarRouter.patch('/events/:eventId', requireCalendarManage, asyncHandler(async (req, res) => {
  const id = positive(req.params.eventId); if (!id) throw new HttpError(400, 'Invalid calendar event ID.');
  const existing = await findLegacyRecord('calendar_events', id); if (!existing) throw new HttpError(404, 'Calendar event not found.');
  if (!canManageEvent(req.auth!, existing.raw)) throw new HttpError(403, 'You do not have permission to edit this calendar event.');
  const input = eventSchemaBase.partial().parse(req.body);
  const start = input.start ?? String(existing.raw.start_at ?? ''); const end = input.end ?? String(existing.raw.end_at ?? '');
  if (input.start || input.end) { const from = new Date(start).valueOf(); const to = new Date(end).valueOf(); if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'End time must be later than start time.'); }
  const employeeIds = input.employeeIds ?? arrayNumbers(existing.raw.employee_ids);
  const conflict = await findConflict(start, end, employeeIds, input.location ?? String(existing.raw.location ?? ''), id);
  if (conflict) throw new HttpError(409, `Calendar conflict with “${conflict.title}”.`);
  const now = nowIso();
  const patch: Record<string, unknown> = { updated_at: now, change_history: [...arrayObjects(existing.raw.change_history), { action: 'updated', by: req.auth!.legacyId, at: now }] };
  if (input.title !== undefined) patch.title = input.title; if (input.description !== undefined) patch.description = input.description ?? '';
  if (input.type !== undefined) patch.type = input.type; if (input.status !== undefined) patch.status = input.status;
  if (input.start !== undefined) patch.start_at = new Date(input.start).toISOString(); if (input.end !== undefined) patch.end_at = new Date(input.end).toISOString();
  if (input.allDay !== undefined) patch.all_day = input.allDay; if (input.departmentId !== undefined) patch.department_id = input.departmentId ?? null;
  if (input.employeeIds !== undefined) patch.employee_ids = employeeIds; if (input.projectId !== undefined) patch.project_id = input.projectId ?? null;
  if (input.location !== undefined) patch.location = input.location ?? null; if (input.priority !== undefined) patch.priority = input.priority;
  if (input.visibility !== undefined) patch.visibility = input.visibility; if (input.reminderChannels !== undefined) patch.reminder_channels = input.reminderChannels;
  if (input.reminderMinutes !== undefined) patch.reminder_minutes = input.reminderMinutes; if (input.recurrence !== undefined) patch.recurrence = input.recurrence ?? null;
  if (input.attachmentIds !== undefined) patch.attachment_ids = input.attachmentIds; if (input.notes !== undefined) patch.notes = input.notes ?? '';
  const updated = await updateLegacyRecord('calendar_events', id, patch); if (!updated) throw new HttpError(404, 'Calendar event not found.');
  await notifyCalendarEmployees(id, employeeIds, req.auth!); emitRealtime('calendar:changed', { action: 'updated', event: toPublicRecord(updated) }, 'workforce');
  res.json({ data: toPublicRecord(updated) });
}));

calendarRouter.delete('/events/:eventId', requireCalendarManage, asyncHandler(async (req, res) => {
  const id = positive(req.params.eventId); if (!id) throw new HttpError(400, 'Invalid calendar event ID.');
  const existing = await findLegacyRecord('calendar_events', id); if (!existing) throw new HttpError(404, 'Calendar event not found.');
  if (!canManageEvent(req.auth!, existing.raw)) throw new HttpError(403, 'You do not have permission to cancel this calendar event.');
  const archived = await archiveLegacyRecord('calendar_events', id); if (!archived) throw new HttpError(404, 'Calendar event not found.');
  res.status(204).send();
}));

function requireCalendarRead(req: Request, res: Response, next: NextFunction): void { if (!req.auth || isCeoRole(req.auth) || isAdminOrHrRole(req.auth) || can(req.auth, 'calendar.view') || isEmployeeRole(req.auth)) { next(); return; } res.status(403).json({ error: 'You do not have permission to view the corporate calendar.' }); }
function requireCalendarManage(req: Request, res: Response, next: NextFunction): void { if (!req.auth || isCeoRole(req.auth) || isAdminOrHrRole(req.auth) || can(req.auth, 'calendar.manage')) { next(); return; } res.status(403).json({ error: 'Only the CEO, Admin, HR, or an authorised calendar manager can manage calendar entries.' }); }
function canManageEvent(auth: AuthContext, raw: Record<string, unknown>): boolean { return isCeoRole(auth) || isAdminOrHrRole(auth) || can(auth, 'calendar.manage') || Number(raw.owner_id) === auth.legacyId; }

interface CalendarFilters { from: string; to: string; type?: string; status?: string; departmentId?: number; employeeId?: number; projectId?: number; search?: string }
async function collectCalendarEvents(auth: AuthContext, filters: CalendarFilters) {
  const sources = await Promise.all([
    listRawRecords('calendar_events', {}, 50_000), listRawRecords('meetings', {}, 20_000), listRawRecords('attendance_holidays', {}, 10_000),
    listRawRecords('tasks', {}, 50_000), listRawRecords('department_projects', {}, 20_000), listRawRecords('leave_requests', {}, 20_000),
    listRawRecords('attendance_shifts', {}, 20_000), listRawRecords('payroll_monthly', {}, 20_000), listRawRecords('salary_slips', {}, 20_000),
    listRawRecords('invoices', {}, 30_000), listRawRecords('payments', {}, 30_000), listRawRecords('recruitment_applicants', {}, 20_000)
  ]);
  const [custom, meetings, holidays, tasks, projects, leave, shifts, payroll, slips, invoices, payments, applicants] = sources;
  const output = [
    ...custom.map((record) => mapRecord(record, 'calendar', 'calendar_events')),
    ...meetings.map((record) => mapRecord(record, 'meeting', 'meetings')),
    ...holidays.map((record) => mapRecord(record, String(record.raw.restricted ? 'restricted_holiday' : 'holiday'), 'attendance_holidays')),
    ...tasks.map((record) => mapRecord(record, 'task', 'tasks', record.raw.due_date, record.raw.due_date)),
    ...projects.map((record) => mapRecord(record, 'milestone', 'department_projects', record.raw.end_date, record.raw.end_date)),
    ...leave.map((record) => mapRecord(record, 'leave', 'leave_requests', record.raw.start_date, record.raw.end_date)),
    ...shifts.map((record) => mapRecord(record, 'shift', 'attendance_shifts', record.raw.date ?? record.raw.shift_date, record.raw.date ?? record.raw.shift_date)),
    ...payroll.map((record) => mapRecord(record, 'payroll', 'payroll_monthly', record.raw.period_month ?? record.raw.month, record.raw.period_month ?? record.raw.month)),
    ...slips.map((record) => mapRecord(record, 'salary', 'salary_slips', record.raw.period_month ?? record.raw.month, record.raw.period_month ?? record.raw.month)),
    ...invoices.map((record) => mapRecord(record, 'invoice', 'invoices', record.raw.due_date ?? record.raw.invoice_date, record.raw.due_date ?? record.raw.invoice_date)),
    ...payments.map((record) => mapRecord(record, 'payment', 'payments', record.raw.payment_date ?? record.raw.date, record.raw.payment_date ?? record.raw.date)),
    ...applicants.map((record) => mapRecord(record, 'recruitment', 'recruitment_applicants', record.raw.interview_date ?? record.raw.joining_date, record.raw.interview_date ?? record.raw.joining_date))
  ].filter((event) => event && visibleTo(auth, event.raw)).filter((event) => matchesEvent(event, filters));
  return output.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

function mapRecord(record: import('../db/legacy.js').LegacyRecord, type: string, collection: string, startValue?: unknown, endValue?: unknown) {
  const raw = record.raw; const start = dateOnly(startValue ?? raw.start_at ?? raw.scheduled_start ?? raw.date ?? raw.created_at); const end = dateOnly(endValue ?? raw.end_at ?? raw.scheduled_end ?? raw.date ?? raw.created_at) ?? start;
  if (!start) return null as never;
  return { id: `${collection}-${record.legacyId}`, legacyId: record.legacyId, sourceCollection: collection, sourceId: record.legacyId, type, title: String(raw.title ?? raw.name ?? raw.event_name ?? raw.invoice_no ?? `${type.replaceAll('_', ' ')} #${record.legacyId}`), description: String(raw.description ?? raw.notes ?? raw.reason ?? ''), start, end: end && end < start ? start : (end ?? start), status: String(raw.status ?? raw.salary_status ?? 'planned'), priority: String(raw.priority ?? 'normal'), location: String(raw.location ?? ''), href: collection === 'meetings' ? `/data/meetings/${record.legacyId}` : collection === 'tasks' ? `/tasks/${record.legacyId}` : collection === 'department_projects' ? `/projects/${record.legacyId}` : `/data/${collection}/${record.legacyId}`, allDay: true, raw };
}

function matchesEvent(event: NonNullable<ReturnType<typeof mapRecord>>, filters: CalendarFilters): boolean { if (event.end < filters.from || event.start > filters.to) return false; if (filters.type && event.type !== filters.type) return false; if (filters.status && event.status !== filters.status) return false; if (filters.search && !`${event.title} ${event.description}`.toLowerCase().includes(filters.search.toLowerCase())) return false; if (filters.projectId && !matchesNumber(event.raw, ['project_id'], filters.projectId)) return false; if (filters.departmentId && !matchesNumber(event.raw, ['department_id'], filters.departmentId)) return false; if (filters.employeeId && !matchesNumber(event.raw, ['user_id', 'assignee_id', 'owner_id', 'employee_id', 'employee_ids'], filters.employeeId)) return false; return true; }
function visibleTo(auth: AuthContext, raw: Record<string, unknown>): boolean { if (isCeoRole(auth) || isAdminOrHrRole(auth) || can(auth, 'calendar.manage')) return true; const id = auth.legacyId; const ids = [...arrayNumbers(raw.employee_ids), Number(raw.user_id), Number(raw.assignee_id), Number(raw.owner_id), Number(raw.organizer_id), Number(raw.created_by)]; if (ids.includes(id)) return true; const visibility = String(raw.visibility ?? '').toLowerCase(); return visibility === 'company' || visibility === 'permitted' || ids.includes(id); }

async function findConflict(start: string, end: string, employeeIds: number[], location?: string, excludeId?: number) { const from = new Date(start).valueOf(); const to = new Date(end).valueOf(); const records = await listRawRecords('calendar_events', {}, 50_000); const conflict = records.find((record) => record.legacyId !== excludeId && overlap(from, to, record.raw.start_at, record.raw.end_at) && (employeeIds.some((id) => arrayNumbers(record.raw.employee_ids).includes(id)) || Boolean(location && String(record.raw.location ?? '').trim().toLowerCase() === location.trim().toLowerCase()))); return conflict ? { title: String(conflict.raw.title ?? 'Calendar entry') } : null; }
function overlap(from: number, to: number, start: unknown, end: unknown): boolean { const left = new Date(String(start ?? '')).valueOf(); const right = new Date(String(end ?? '')).valueOf(); return Number.isFinite(left) && Number.isFinite(right) && left < to && right > from; }
async function notifyCalendarEmployees(eventId: number, employeeIds: number[], actor: AuthContext): Promise<void> { for (const userId of [...new Set(employeeIds)].filter((id) => id > 0 && id !== actor.legacyId)) { const notification = await createLegacyRecord('notifications', { user_id: userId, title: 'Calendar entry assigned', body: `${actor.name} added a calendar entry for you.`, type: 'calendar', priority: 'normal', url: `/calendar?event=${eventId}`, is_read: 0, created_at: nowIso() }); emitRealtime('notification:new', { notification: toPublicRecord(notification) }, `user:${userId}`); } }
function arrayNumbers(value: unknown): number[] { return Array.isArray(value) ? value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : []; }
function arrayObjects(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')) : []; }
function matchesNumber(raw: Record<string, unknown>, fields: string[], value: number): boolean { return fields.some((field) => arrayNumbers(raw[field]).includes(value) || Number(raw[field]) === value); }
function dateQuery(value: unknown): string | undefined { const text = stringQuery(value); return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined; }
function dateOnly(value: unknown): string | null { const text = String(value ?? '').trim(); if (!text) return null; const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`; const parsed = new Date(text); return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10); }
function monthStart(): string { const date = new Date(); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10); }
function monthEnd(): string { const date = new Date(); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); }
function stringQuery(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function numberQuery(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
function positive(value: unknown): number | undefined { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function nowIso(): string { return new Date().toISOString(); }

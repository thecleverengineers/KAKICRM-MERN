import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { createLegacyRecord, findLegacyRecord, listLegacyRecords, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecordWithRelations } from '../services/relationLabels.js';
import { can } from '../services/permissions.js';
import { persistIncomingFile } from '../services/storage.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const requestSchema = z.object({
  leave_type: z.string().trim().min(2).max(100),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(2).max(5_000)
});

export const leaveRouter = Router();
leaveRouter.use(requireAuth);

leaveRouter.get('/mine', asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('leave_requests', {
    page: positive(req.query.page, 1),
    limit: positive(req.query.limit, 50),
    filters: { user_id: req.auth!.legacyId },
    sort: 'applied_at',
    order: 'desc'
  });
  res.json(result);
}));

leaveRouter.get('/manage', requirePermission('leave.view'), asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('leave_requests', {
    page: positive(req.query.page, 1),
    limit: positive(req.query.limit, 100),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    searchFields: ['leave_type', 'status', 'reason'],
    sort: 'applied_at',
    order: 'desc',
    filters: typeof req.query.status === 'string' ? { status: req.query.status } : undefined
  });
  res.json(result);
}));

leaveRouter.post('/apply', upload.array('files', 10), asyncHandler(async (req, res) => {
  const input = requestSchema.parse(req.body);
  if (input.end_date < input.start_date) throw new HttpError(400, 'The end date must be on or after the start date.');
  const request = await createLegacyRecord('leave_requests', {
    user_id: req.auth!.legacyId,
    leave_type: input.leave_type,
    start_date: input.start_date,
    end_date: input.end_date,
    days_count: daysInclusive(input.start_date, input.end_date),
    reason: input.reason,
    status: 'pending',
    applied_at: nowIst(),
    reviewed_by: null,
    reviewed_at: null,
    review_note: null
  });
  const files = Array.isArray(req.files) ? req.files : [];
  const attachments = await Promise.all(files.map(async (file) => {
    const saved = await persistIncomingFile(file, 'leave-proofs');
    return createLegacyRecord('leave_request_files', {
      leave_id: request.legacyId,
      stored_name: saved.relativePath,
      original_name: file.originalname,
      mime: file.mimetype,
      size_bytes: file.size,
      created_at: nowIst()
    });
  }));
  res.status(201).json({ data: toPublicRecord(request), attachments: attachments.map(toPublicRecord) });
}));

leaveRouter.get('/:leaveId', asyncHandler(async (req, res) => {
  const leave = await findLegacyRecord('leave_requests', identifier(req.params.leaveId));
  if (!leave) throw new HttpError(404, 'Leave request not found.');
  const isRequestOwner = Number(leave.raw.user_id) === req.auth!.legacyId;
  const canReviewLeave = can(req.auth!, 'leave.view') || can(req.auth!, 'leave.manage');
  if (!isRequestOwner && !canReviewLeave) throw new HttpError(404, 'Leave request not found.');
  res.json({ data: await toPublicRecordWithRelations('leave_requests', leave) });
}));

leaveRouter.patch('/:leaveId/review', requirePermission('leave.manage'), asyncHandler(async (req, res) => {
  const input = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(2_000).optional().nullable() }).parse(req.body);
  const leave = await findLegacyRecord('leave_requests', identifier(req.params.leaveId));
  if (!leave) throw new HttpError(404, 'Leave request not found.');
  if (String(leave.raw.status) !== 'pending') throw new HttpError(409, 'This leave request has already been reviewed.');
  const updated = await updateLegacyRecord('leave_requests', leave.legacyId!, {
    status: input.status,
    reviewed_by: req.auth!.legacyId,
    reviewed_at: nowIst(),
    review_note: input.note ?? null
  });
  if (input.status === 'approved') await markApprovedLeaveInAttendance(leave);
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

leaveRouter.post('/:leaveId/cancel', asyncHandler(async (req, res) => {
  const leave = await findLegacyRecord('leave_requests', identifier(req.params.leaveId));
  if (!leave || Number(leave.raw.user_id) !== req.auth!.legacyId) throw new HttpError(404, 'Leave request not found.');
  if (String(leave.raw.status) !== 'pending') throw new HttpError(409, 'Only pending leave requests can be cancelled.');
  const updated = await updateLegacyRecord('leave_requests', leave.legacyId!, { status: 'cancelled', reviewed_at: nowIst() });
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

async function markApprovedLeaveInAttendance(leave: { raw: Record<string, unknown> }): Promise<void> {
  const userId = Number(leave.raw.user_id);
  const start = String(leave.raw.start_date);
  const end = String(leave.raw.end_date);
  for (const date of dateRange(start, end)) {
    const existing = await listRawRecords('attendance_logs', { 'raw.user_id': userId, 'raw.date': date }, 1);
    if (!existing.length) {
      await createLegacyRecord('attendance_logs', {
        user_id: userId,
        date,
        status: 'leave',
        attendance_type: 'leave',
        source: 'leave_approval',
        total_minutes: 0,
        break_minutes: 0,
        late_minutes: 0,
        early_exit_minutes: 0,
        overtime_minutes: 0,
        notes: `Approved leave #${String(leave.raw.id ?? '')}`,
        created_at: nowIst(),
        updated_at: nowIst()
      });
    }
  }
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const until = new Date(`${end}T00:00:00Z`);
  while (cursor <= until) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function daysInclusive(start: string, end: string): number {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

function identifier(value: string | string[] | undefined): number {
  const result = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new HttpError(400, 'Invalid leave request ID.');
  return result;
}

function positive(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? Math.floor(result) : fallback;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

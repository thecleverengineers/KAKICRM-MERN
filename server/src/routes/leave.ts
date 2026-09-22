import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { createLegacyRecord, findLegacyRecord, listLegacyRecords, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecordWithRelations } from '../services/relationLabels.js';
import { canManageLeave, canViewLeave } from '../services/permissions.js';
import { openStoredFile, persistIncomingFile } from '../services/storage.js';
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

leaveRouter.get('/manage', requireLeaveView, asyncHandler(async (req, res) => {
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
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) throw new HttpError(400, 'Upload at least one proof document before submitting your leave request.');
  if (files.some((file) => !allowedProofFile(file))) {
    throw new HttpError(400, 'Proof files must be PDF, JPG, PNG, or WebP documents.');
  }
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

leaveRouter.get('/:leaveId/files', asyncHandler(async (req, res) => {
  const leave = await accessibleLeave(req, identifier(req.params.leaveId));
  const files = await listRawRecords('leave_request_files', { 'raw.leave_id': leave.legacyId }, 100);
  res.json({ data: files.map((file) => ({
    legacyId: file.legacyId,
    name: String(file.raw.original_name ?? 'Proof document'),
    mime: String(file.raw.mime ?? 'application/octet-stream'),
    sizeBytes: Number(file.raw.size_bytes ?? 0),
    createdAt: String(file.raw.created_at ?? file.createdAt)
  })) });
}));

leaveRouter.get('/:leaveId/files/:fileId', asyncHandler(async (req, res) => {
  const leave = await accessibleLeave(req, identifier(req.params.leaveId));
  const file = await findLegacyRecord('leave_request_files', identifier(req.params.fileId));
  if (!file || Number(file.raw.leave_id) !== leave.legacyId) throw new HttpError(404, 'Leave proof document not found.');
  const { stream } = await openStoredFile(String(file.raw.stored_name ?? ''));
  const fileName = String(file.raw.original_name ?? 'proof-document').replace(/[\r\n"]/g, '');
  const mime = allowedProofMimeTypes.has(String(file.raw.mime).toLowerCase()) ? String(file.raw.mime).toLowerCase() : 'application/octet-stream';
  const inline = mime === 'application/pdf' || mime.startsWith('image/');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fileName || 'proof-document'}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.pipe(res);
}));

leaveRouter.get('/:leaveId', asyncHandler(async (req, res) => {
  const leave = await accessibleLeave(req, identifier(req.params.leaveId));
  res.json({ data: await toPublicRecordWithRelations('leave_requests', leave) });
}));

leaveRouter.patch('/:leaveId/review', requireLeaveManager, asyncHandler(async (req, res) => {
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

const allowedProofMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function allowedProofFile(file: Express.Multer.File): boolean {
  return allowedProofMimeTypes.has(file.mimetype.toLowerCase());
}

async function accessibleLeave(req: import('express').Request, id: number) {
  const leave = await findLegacyRecord('leave_requests', id);
  if (!leave) throw new HttpError(404, 'Leave request not found.');
  const isRequestOwner = Number(leave.raw.user_id) === req.auth!.legacyId;
  if (!isRequestOwner && !canViewLeave(req.auth!)) throw new HttpError(404, 'Leave request not found.');
  return leave;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function requireLeaveView(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (req.auth && canViewLeave(req.auth)) { next(); return; }
  res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'You do not have permission to manage leave requests.' : 'Authentication is required.' });
}

function requireLeaveManager(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (req.auth && canManageLeave(req.auth)) { next(); return; }
  res.status(req.auth ? 403 : 401).json({ error: req.auth ? 'You do not have permission to review leave requests.' : 'Authentication is required.' });
}

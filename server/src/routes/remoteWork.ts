import { Router } from 'express';
import { z } from 'zod';
import { toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { asyncHandler, HttpError } from '../utils/http.js';

export const remoteWorkRouter = Router();
remoteWorkRouter.use(requireAuth);

remoteWorkRouter.get('/me', asyncHandler(async (req, res) => {
  const [shifts, checkins, logs] = await Promise.all([
    listRawRecords('remote_shifts', { 'raw.user_id': req.auth!.legacyId }, 100),
    listRawRecords('daily_checkins', { 'raw.user_id': req.auth!.legacyId }, 100),
    listRawRecords('time_logs', { 'raw.user_id': req.auth!.legacyId }, 100)
  ]);
  res.json({
    shifts: shifts.map(toPublicRecord),
    checkins: checkins.map(toPublicRecord),
    timeLogs: logs.map(toPublicRecord)
  });
}));

remoteWorkRouter.post('/clock-in', asyncHandler(async (req, res) => {
  const open = await listRawRecords('remote_shifts', { 'raw.user_id': req.auth!.legacyId, 'raw.clock_out_utc': null }, 1);
  if (open.length) throw new HttpError(409, 'You already have an active remote-work shift.');
  const now = new Date();
  const shift = await createLegacyRecord('remote_shifts', {
    user_id: req.auth!.legacyId,
    clock_in_utc: now.toISOString(),
    clock_out_utc: null,
    clock_in_ist: toIst(now),
    clock_out_ist: null,
    duration_seconds: null,
    created_at: now.toISOString()
  });
  res.status(201).json({ data: toPublicRecord(shift) });
}));

remoteWorkRouter.post('/clock-out', asyncHandler(async (req, res) => {
  const [shift] = await listRawRecords('remote_shifts', { 'raw.user_id': req.auth!.legacyId, 'raw.clock_out_utc': null }, 1);
  if (!shift) throw new HttpError(409, 'There is no active remote-work shift.');
  const now = new Date();
  const startedAt = new Date(String(shift.raw.clock_in_utc)).getTime();
  const updated = await updateLegacyRecord('remote_shifts', shift.legacyId!, {
    clock_out_utc: now.toISOString(),
    clock_out_ist: toIst(now),
    duration_seconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((now.getTime() - startedAt) / 1000)) : 0
  });
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

remoteWorkRouter.post('/checkins', asyncHandler(async (req, res) => {
  const input = z.object({ today_plan: z.string().trim().min(2).max(10_000), blockers: z.string().max(5_000).optional().nullable(), priorities: z.string().max(5_000).optional().nullable() }).parse(req.body);
  const date = todayIst();
  const existing = await listRawRecords('daily_checkins', { 'raw.user_id': req.auth!.legacyId, 'raw.checkin_date': date }, 1);
  if (existing[0]) {
    const updated = await updateLegacyRecord('daily_checkins', existing[0].legacyId!, input);
    res.json({ data: updated ? toPublicRecord(updated) : null });
    return;
  }
  const record = await createLegacyRecord('daily_checkins', { user_id: req.auth!.legacyId, checkin_date: date, ...input, created_at: new Date().toISOString() });
  res.status(201).json({ data: toPublicRecord(record) });
}));

remoteWorkRouter.post('/time-logs/start', asyncHandler(async (req, res) => {
  const input = z.object({ task_id: z.coerce.number().int().positive().optional().nullable(), note: z.string().max(1_000).optional().nullable() }).parse(req.body);
  const open = await listRawRecords('time_logs', { 'raw.user_id': req.auth!.legacyId, 'raw.end_utc': null }, 1);
  if (open.length) throw new HttpError(409, 'Stop the current timer before starting another one.');
  const now = new Date();
  const record = await createLegacyRecord('time_logs', {
    user_id: req.auth!.legacyId,
    task_id: input.task_id ?? null,
    start_utc: now.toISOString(),
    end_utc: null,
    start_ist: toIst(now),
    end_ist: null,
    duration_seconds: null,
    log_type: 'timer',
    note: input.note ?? null,
    created_at: now.toISOString()
  });
  res.status(201).json({ data: toPublicRecord(record) });
}));

remoteWorkRouter.post('/time-logs/stop', asyncHandler(async (req, res) => {
  const [open] = await listRawRecords('time_logs', { 'raw.user_id': req.auth!.legacyId, 'raw.end_utc': null }, 1);
  if (!open) throw new HttpError(409, 'There is no active timer.');
  const now = new Date();
  const duration = Math.max(0, Math.round((now.getTime() - new Date(String(open.raw.start_utc)).getTime()) / 1000));
  const updated = await updateLegacyRecord('time_logs', open.legacyId!, { end_utc: now.toISOString(), end_ist: toIst(now), duration_seconds: duration });
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

remoteWorkRouter.get('/manage', requirePermission('remotework.view'), asyncHandler(async (_req, res) => {
  const shifts = await listRawRecords('remote_shifts', {}, 1_000);
  res.json({ data: shifts.map(toPublicRecord) });
}));

function toIst(date: Date): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  return `${day} ${time}`;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

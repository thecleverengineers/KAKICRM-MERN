import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { createLegacyRecord, listRawRecords } from '../services/legacyRepository.js';
import { legacyAssetUrl, persistIncomingFile } from '../services/storage.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
export const driveRouter = Router();
driveRouter.use(requireAuth);

driveRouter.get('/items', requirePermission('drive.view'), asyncHandler(async (req, res) => {
  const parentId = req.query.parentId === undefined || req.query.parentId === '' ? null : Number(req.query.parentId);
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) throw new HttpError(400, 'Invalid folder ID.');
  const query = parentId === null ? { 'raw.parent_id': null } : { 'raw.parent_id': parentId };
  const items = await listRawRecords('drive_items', query, 1_000);
  res.json({ data: items.map((item) => ({ ...toPublicRecord(item), url: item.raw.storage_path ? driveUrl(String(item.raw.storage_path)) : null })) });
}));

driveRouter.post('/folders', requirePermission('drive.manage'), asyncHandler(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(1).max(255), parent_id: z.coerce.number().int().positive().optional().nullable() }).parse(req.body);
  const folder = await createLegacyRecord('drive_items', {
    user_id: req.auth!.legacyId,
    parent_id: input.parent_id ?? null,
    type: 'folder',
    name: input.name,
    mime_type: null,
    size: 0,
    storage_path: null,
    created_at: nowIst()
  });
  res.status(201).json({ data: toPublicRecord(folder) });
}));

driveRouter.post('/files', requirePermission('drive.manage'), upload.array('files', 20), asyncHandler(async (req, res) => {
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) throw new HttpError(400, 'Invalid folder ID.');
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) throw new HttpError(400, 'Select at least one file.');
  const stored = await Promise.all(files.map(async (file) => {
    const saved = await persistIncomingFile(file, 'drive');
    return createLegacyRecord('drive_items', {
      user_id: req.auth!.legacyId,
      parent_id: parentId,
      type: 'file',
      name: file.originalname,
      mime_type: file.mimetype,
      size: file.size,
      storage_path: saved.relativePath,
      created_at: nowIst()
    });
  }));
  res.status(201).json({ data: stored.map((item) => ({ ...toPublicRecord(item), url: driveUrl(String(item.raw.storage_path)) })) });
}));

function driveUrl(value: string): string {
  return legacyAssetUrl(value.startsWith('modern/') ? value : `legacy/storage/drive/${value}`);
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { createLegacyRecord, findLegacyRecord, listLegacyRecords, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { persistIncomingFile } from '../services/storage.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const applicantSchema = z.object({
  position_id: z.coerce.number().int().positive(),
  full_name: z.string().trim().min(2).max(255),
  email: z.string().email().max(255).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  current_company: z.string().max(255).optional().nullable(),
  experience_years: z.coerce.number().min(0).max(100).optional().nullable(),
  source: z.string().max(100).optional().nullable(),
  current_ctc: z.coerce.number().min(0).optional().nullable(),
  expected_ctc: z.coerce.number().min(0).optional().nullable(),
  notice_period: z.string().max(100).optional().nullable(),
  location: z.string().max(255).optional().nullable(),
  notes: z.string().max(10_000).optional().nullable()
});

export const recruitmentRouter = Router();
recruitmentRouter.use(requireAuth);

recruitmentRouter.get('/positions', requirePermission('recruitments.view'), asyncHandler(async (_req, res) => {
  const positions = await listRawRecords('recruitment_positions', {}, 1_000);
  res.json({ data: positions.map(toPublicRecord) });
}));

recruitmentRouter.get('/applicants', requirePermission('recruitments.applicants.view'), asyncHandler(async (req, res) => {
  const positionId = typeof req.query.positionId === 'string' ? Number(req.query.positionId) : undefined;
  const result = await listLegacyRecords('recruitment_applicants', {
    page: positive(req.query.page, 1),
    limit: positive(req.query.limit, 50),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    searchFields: ['full_name', 'email', 'phone', 'stage', 'status'],
    sort: 'updated_at',
    order: 'desc',
    filters: Number.isSafeInteger(positionId) && positionId! > 0 ? { position_id: positionId! } : undefined
  });
  res.json(result);
}));

recruitmentRouter.post('/applicants', requirePermission('recruitments.applicants.manage'), upload.array('files', 10), asyncHandler(async (req, res) => {
  const input = applicantSchema.parse(req.body);
  const applicant = await createLegacyRecord('recruitment_applicants', {
    ...input,
    stage: 'applied',
    status: 'active',
    resume_file: null,
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  const files = Array.isArray(req.files) ? req.files : [];
  const attachments = await saveApplicantFiles(applicant.legacyId!, input.position_id, req.auth!.legacyId, files);
  res.status(201).json({ data: toPublicRecord(applicant), attachments: attachments.map(toPublicRecord) });
}));

recruitmentRouter.patch('/applicants/:applicantId/stage', requirePermission('recruitments.applicants.manage'), asyncHandler(async (req, res) => {
  const id = identifier(req.params.applicantId);
  const input = z.object({ stage: z.string().trim().min(2).max(100), note: z.string().max(5_000).optional().nullable() }).parse(req.body);
  const applicant = await findLegacyRecord('recruitment_applicants', id);
  if (!applicant) throw new HttpError(404, 'Applicant not found.');
  const oldStage = String(applicant.raw.stage ?? 'applied');
  const updated = await updateLegacyRecord('recruitment_applicants', id, { stage: input.stage, updated_at: nowIst() });
  await createLegacyRecord('recruitment_applicant_logs', {
    applicant_id: id,
    position_id: applicant.raw.position_id,
    old_stage: oldStage,
    new_stage: input.stage,
    comment: input.note ?? null,
    note: input.note ?? null,
    changed_by: req.auth!.legacyId,
    created_at: nowIst()
  });
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

recruitmentRouter.post('/applicants/:applicantId/files', requirePermission('recruitments.applicants.manage'), upload.array('files', 10), asyncHandler(async (req, res) => {
  const id = identifier(req.params.applicantId);
  const applicant = await findLegacyRecord('recruitment_applicants', id);
  if (!applicant) throw new HttpError(404, 'Applicant not found.');
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) throw new HttpError(400, 'Select at least one file.');
  const attachments = await saveApplicantFiles(id, Number(applicant.raw.position_id), req.auth!.legacyId, files);
  res.status(201).json({ data: attachments.map(toPublicRecord) });
}));

async function saveApplicantFiles(applicantId: number, positionId: number, uploadedBy: number, files: Express.Multer.File[]) {
  return Promise.all(files.map(async (file) => {
    const saved = await persistIncomingFile(file, 'recruitment');
    return createLegacyRecord('recruitment_files', {
      applicant_id: applicantId,
      position_id: positionId,
      file_name: saved.relativePath,
      original_name: file.originalname,
      mime_type: file.mimetype,
      file_size: file.size,
      uploaded_by: uploadedBy,
      created_at: nowIst()
    });
  }));
}

function identifier(value: string | string[] | undefined): number {
  const result = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new HttpError(400, 'Invalid applicant ID.');
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

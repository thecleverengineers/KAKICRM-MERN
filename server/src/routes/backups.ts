import { existsSync, mkdirSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { isCeoRole } from '../services/permissions.js';
import {
  backupPath, importBackup, listBackups, readState, removeTemporary,
  startBackup, startRestore, startVerify, systemStatus
} from '../services/backupService.js';
import {
  backupGoogleDriveStatus,
  connectBackupFolder,
  createAndConnectBackupFolder,
  disconnectBackupGoogleDrive,
  listBackupFolders,
  testBackupGoogleDrive
} from '../services/backupGoogleDrive.js';
import { createOAuthState, googleAuthorizationUrl, loadGoogleOAuthConfig } from '../services/googleMeet.js';

export const backupsRouter = Router();
const incoming = `${env.backupRoot}/incoming`;
mkdirSync(incoming, { recursive: true, mode: 0o700 });
const upload = multer({
  dest: incoming,
  limits: { files: 1, fileSize: env.BACKUP_MAX_UPLOAD_GB * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.originalname.endsWith('.tar.gz.gpg'))
});

const folderNameSchema = z.object({ name: z.string().trim().max(120).default('KAKI CRM Backups') });
const folderReferenceSchema = z.object({ folder: z.string().trim().min(10).max(2_000) });

backupsRouter.use(requireAuth, requireBackupOperator);

backupsRouter.get('/', async (_req, res, next) => {
  try {
    const [data, state, googleDrive] = await Promise.all([listBackups(), readState(), backupGoogleDriveStatus(_req.auth!.legacyId)]);
    res.json({ data, state, system: systemStatus(), googleDrive });
  } catch (error) { next(error); }
});

backupsRouter.post('/', (_req, res, next) => {
  try { res.status(202).json({ message: 'Full encrypted backup started.', pid: startBackup(_req.auth?.email ?? 'administrator') }); } catch (error) { next(error); }
});

backupsRouter.post('/import', upload.single('backup'), async (req, res, next) => {
  try {
    if (!req.file || !existsSync(req.file.path)) { res.status(400).json({ error: 'Select a .tar.gz.gpg backup file.' }); return; }
    const id = await importBackup(req.file.path);
    res.status(201).json({ message: 'Encrypted backup imported. Verify it before restoring.', id });
  } catch (error) {
    await removeTemporary(req.file?.path);
    next(error);
  }
});

backupsRouter.get('/google/status', async (req, res, next) => {
  try { res.json({ data: await backupGoogleDriveStatus(req.auth!.legacyId) }); } catch (error) { next(error); }
});

backupsRouter.get('/google/connect', async (req, res, next) => {
  try {
    await loadGoogleOAuthConfig();
    const state = await createOAuthState(req.auth!.legacyId, 'backup');
    res.json({ url: googleAuthorizationUrl(state, 'backup') });
  } catch (error) { next(error); }
});

backupsRouter.get('/google/folders', async (req, res, next) => {
  try { res.json({ data: await listBackupFolders(req.auth!.legacyId) }); } catch (error) { next(error); }
});

backupsRouter.post('/google/folders', async (req, res, next) => {
  try {
    const input = folderNameSchema.parse(req.body ?? {});
    res.status(201).json({ data: await createAndConnectBackupFolder(req.auth!.legacyId, input.name), message: 'Google Drive backup folder created and connected.' });
  } catch (error) { next(error); }
});

backupsRouter.put('/google/folder', async (req, res, next) => {
  try {
    const input = folderReferenceSchema.parse(req.body);
    res.json({ data: await connectBackupFolder(req.auth!.legacyId, input.folder), message: 'Google Drive backup folder connected.' });
  } catch (error) { next(error); }
});

backupsRouter.post('/google/test', async (req, res, next) => {
  try { res.json({ data: await testBackupGoogleDrive(req.auth!.legacyId), message: 'Google Drive write test passed.' }); } catch (error) { next(error); }
});

backupsRouter.delete('/google', async (req, res, next) => {
  try { res.json({ data: await disconnectBackupGoogleDrive(req.auth!.legacyId), message: 'Google Drive backup destination disconnected. The Google account remains available for meetings.' }); } catch (error) { next(error); }
});

backupsRouter.get('/:id/download', (req, res, next) => {
  try {
    const archive = backupPath(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.download(archive, req.params.id);
  } catch (error) { next(error); }
});

backupsRouter.post('/:id/verify', (req, res, next) => {
  try { res.status(202).json({ message: 'Integrity and decryptability verification started.', pid: startVerify(req.params.id, req.auth?.email ?? 'administrator') }); } catch (error) { next(error); }
});

backupsRouter.post('/:id/restore', (req, res, next) => {
  try {
    const expected = `RESTORE ${req.params.id}`;
    if (req.body?.confirmation !== expected) {
      res.status(400).json({ error: `Type exactly: ${expected}` });
      return;
    }
    res.status(202).json({ message: 'Disaster-recovery restore started. The CRM will restart after validation.', pid: startRestore(req.params.id, req.auth?.email ?? 'administrator') });
  } catch (error) { next(error); }
});

function requireBackupOperator(req: Request, res: Response, next: NextFunction): void {
  const role = req.auth?.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (req.auth?.permissions.includes('*') || role === 'admin' || role === 'administrator' || (req.auth && isCeoRole(req.auth))) { next(); return; }
  res.status(403).json({ error: 'Only the CEO or a system administrator can access Backup & Restore.' });
}

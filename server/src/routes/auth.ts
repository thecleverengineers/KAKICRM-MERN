import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import { getLegacyModel, toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth, signAccessToken } from '../middleware/auth.js';
import { buildAuthContext } from '../services/permissions.js';
import { updateLegacyRecord } from '../services/legacyRepository.js';
import { persistIncomingFile, storedAssetUrl } from '../services/storage.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const loginSchema = z.object({
  email: z.string().email().max(150),
  password: z.string().min(1).max(512)
});
const whatsappNumberSchema = z.object({
  whatsappNumber: z.string().trim().min(1, 'Enter your WhatsApp number.').max(32, 'Enter a valid WhatsApp number.')
});
const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(32).optional().nullable(),
  whatsapp_number: z.string().trim().max(32).optional().nullable(),
  address: z.string().trim().max(1_000).optional().nullable(),
  emergency_contact: z.string().trim().max(120).optional().nullable(),
  bio: z.string().trim().max(1_000).optional().nullable(),
  date_of_birth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date of birth.').optional().nullable()
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(128, 'Password is too long.')
}).refine((value) => value.currentPassword !== value.newPassword, { path: ['newPassword'], message: 'Choose a password different from your current password.' });
const profileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

export const authRouter = Router();

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const normalized = email.trim().toLowerCase();
  const user = await getLegacyModel('users')
    .findOne({ 'raw.email': new RegExp(`^${escapeRegex(normalized)}$`, 'i'), archivedAt: { $exists: false } })
    .lean<LegacyRecord | null>();

  if (!user || !isActiveUser(user.raw.status)) {
    throw new HttpError(401, 'Email or password is incorrect.');
  }

  const valid = await verifyLegacyPassword(password, user.raw);
  if (!valid) throw new HttpError(401, 'Email or password is incorrect.');

  const auth = await buildAuthContext(user);
  res.json({ token: signAccessToken(auth.recordId), user: { ...auth, record: toPublicRecord(user) } });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const user = await getLegacyModel('users').findById(req.auth.recordId).lean<LegacyRecord | null>();
  if (!user) throw new HttpError(401, 'This session is no longer valid.');
  res.json({ user: { ...req.auth, record: toPublicRecord(user) } });
}));

authRouter.put('/me/whatsapp-number', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const { whatsappNumber: suppliedNumber } = whatsappNumberSchema.parse(req.body);
  const whatsappNumber = normalizeWhatsAppNumber(suppliedNumber);
  const updatedAt = nowIst();
  const user = await updateLegacyRecord('users', req.auth.legacyId, {
    whatsapp_number: whatsappNumber,
    whatsapp_updated_at: updatedAt,
    updated_at: updatedAt
  });
  if (!user) throw new HttpError(401, 'This session is no longer valid.');

  const auth = await buildAuthContext(user);
  res.json({ user: { ...auth, record: toPublicRecord(user) } });
}));

authRouter.put('/me/profile', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const input = profileSchema.parse(req.body);
  const whatsappNumber = input.whatsapp_number ? normalizeWhatsAppNumber(input.whatsapp_number) : null;
  const updatedAt = nowIst();
  const user = await updateLegacyRecord('users', req.auth.legacyId, {
    name: input.name,
    phone: input.phone || null,
    whatsapp_number: whatsappNumber,
    address: input.address || null,
    emergency_contact: input.emergency_contact || null,
    bio: input.bio || null,
    date_of_birth: input.date_of_birth || null,
    profile_updated_at: updatedAt,
    updated_at: updatedAt
  });
  if (!user) throw new HttpError(401, 'This session is no longer valid.');
  const auth = await buildAuthContext(user);
  res.json({ user: { ...auth, record: toPublicRecord(user) } });
}));

authRouter.post('/me/profile-image', requireAuth, profileUpload.single('image'), asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const file = req.file;
  if (!file) throw new HttpError(400, 'Select a profile image to upload.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
    throw new HttpError(400, 'Upload a PNG, JPG, or WEBP profile image.');
  }
  const saved = await persistIncomingFile(file, 'profile-images');
  const updatedAt = nowIst();
  const user = await updateLegacyRecord('users', req.auth.legacyId, {
    profile_image_url: storedAssetUrl(saved.relativePath),
    avatar_url: storedAssetUrl(saved.relativePath),
    profile_updated_at: updatedAt,
    updated_at: updatedAt
  });
  if (!user) throw new HttpError(401, 'This session is no longer valid.');
  const auth = await buildAuthContext(user);
  res.status(201).json({ user: { ...auth, record: toPublicRecord(user) } });
}));

authRouter.post('/me/change-password', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const input = passwordChangeSchema.parse(req.body);
  const user = await getLegacyModel('users').findById(req.auth.recordId).lean<LegacyRecord | null>();
  if (!user) throw new HttpError(401, 'This session is no longer valid.');
  if (!(await verifyLegacyPassword(input.currentPassword, user.raw))) {
    throw new HttpError(400, 'Your current password is incorrect.');
  }
  const updatedAt = nowIst();
  const updated = await updateLegacyRecord('users', req.auth.legacyId, {
    password_hash: await bcrypt.hash(input.newPassword, 12),
    password_updated_at: updatedAt,
    password_updated_by: req.auth.legacyId,
    updated_at: updatedAt
  });
  if (!updated) throw new HttpError(401, 'This session is no longer valid.');
  res.json({ message: 'Your password has been changed successfully.' });
}));

authRouter.post('/logout', requireAuth, (_req, res) => {
  // Access tokens are stateless. The client discards the token; rotation/revocation can be added without altering legacy users.
  res.status(204).send();
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQL migrations retain source columns as-is. Some legacy installations used
 * `password`, while newer ones used `password_hash`. Accept either bcrypt
 * field so an otherwise-valid migrated account is not locked out.
 */
async function verifyLegacyPassword(password: string, raw: Record<string, unknown>): Promise<boolean> {
  const value = raw.password_hash ?? raw.password;
  if (typeof value !== 'string' || !value.trim()) return false;

  // PHP's password_hash commonly emits $2y$. bcryptjs uses the equivalent
  // $2b$ prefix, so normalize it before validating the same bcrypt digest.
  const hash = value.trim().replace(/^\$2y\$/, '$2b$');
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // A malformed legacy value must behave as an invalid login, never a 500.
    return false;
  }
}

function isActiveUser(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return ['active', '1', 'true', 'enabled'].includes(String(value).trim().toLowerCase());
}

function normalizeWhatsAppNumber(value: string): string {
  const compact = value.trim().replace(/[()\s.-]/g, '');
  if (!/^\+?[1-9]\d{6,14}$/.test(compact)) {
    throw new HttpError(400, 'Enter a valid WhatsApp number, including country code if needed.');
  }
  return compact;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

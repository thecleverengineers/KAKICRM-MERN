import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { listRawRecords } from '../services/legacyRepository.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const pinSchema = z.string().regex(/^\d{6}$/, 'Enter a six-digit code.');
const setupSchema = z.object({ pin: pinSchema });
const changePinSchema = z.object({ currentPin: pinSchema, newPin: pinSchema });
const idListSchema = z.array(z.coerce.number().int().positive()).max(100);
const credentialInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  website: z.string().trim().max(500).optional().default(''),
  username: z.string().max(500).optional().default(''),
  password: z.string().min(1).max(2_000),
  notes: z.string().max(10_000).optional().default(''),
  sharedWithUserIds: idListSchema.optional().default([])
});

const pinModel = mongoose.models.CredentialVaultPin ?? mongoose.model('CredentialVaultPin', new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  pinHash: { type: String, required: true },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  sessionVersion: { type: Number, default: 0 }
}, { collection: 'credential_vault_pins', timestamps: true, strict: true, versionKey: false }));

const credentialModel = mongoose.models.CredentialVaultCredential ?? mongoose.model('CredentialVaultCredential', new mongoose.Schema({
  ownerUserId: { type: Number, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  website: { type: String, default: '', maxlength: 500 },
  usernameCiphertext: { type: String, required: true },
  passwordCiphertext: { type: String, required: true },
  notesCiphertext: { type: String, default: '' },
  sharedWithUserIds: { type: [Number], default: [], index: true }
}, { collection: 'credential_vault_credentials', timestamps: true, strict: true, versionKey: false }));

const unlockLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const setupLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });

export const credentialVaultRouter = Router();
credentialVaultRouter.use(requireAuth);

credentialVaultRouter.get('/status', asyncHandler(async (req, res) => {
  const pin = await pinModel.findOne({ userId: req.auth!.legacyId }).select({ _id: 1 }).lean();
  res.json({ configured: Boolean(pin) });
}));

credentialVaultRouter.post('/setup', setupLimiter, asyncHandler(async (req, res) => {
  const { pin } = setupSchema.parse(req.body);
  const existing = await pinModel.findOne({ userId: req.auth!.legacyId }).select({ _id: 1 }).lean();
  if (existing) throw new HttpError(409, 'Your vault code is already set. Unlock the vault to change it.');
  const pinHash = await bcrypt.hash(pin, 12);
  try {
    await pinModel.create({ userId: req.auth!.legacyId, pinHash, failedAttempts: 0, lockedUntil: null, sessionVersion: 0 });
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, 'Your vault code is already set. Unlock the vault to change it.');
    throw error;
  }
  res.status(201).json({ configured: true, message: 'Your vault code is ready. Unlock the vault to continue.' });
}));

credentialVaultRouter.post('/unlock', unlockLimiter, asyncHandler(async (req, res) => {
  const { pin } = setupSchema.parse(req.body);
  const record: any = await pinModel.findOne({ userId: req.auth!.legacyId }).lean().exec();
  if (!record) throw new HttpError(409, 'Set a six-digit code before unlocking the vault.');
  const now = Date.now();
  const lockedUntil = record.lockedUntil ? new Date(record.lockedUntil).getTime() : 0;
  if (lockedUntil > now) throw new HttpError(429, `Too many incorrect codes. Try again in ${Math.ceil((lockedUntil - now) / 60_000)} minutes.`);
  if (!await bcrypt.compare(pin, String(record.pinHash))) {
    const attempts = Number(record.failedAttempts ?? 0) + 1;
    await pinModel.updateOne({ userId: req.auth!.legacyId }, {
      $set: { failedAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(now + 15 * 60_000) : null }
    });
    throw new HttpError(attempts >= 5 ? 429 : 401, attempts >= 5 ? 'Too many incorrect codes. Your vault is locked for 15 minutes.' : 'That code did not unlock the vault.');
  }
  await pinModel.updateOne({ userId: req.auth!.legacyId }, { $set: { failedAttempts: 0, lockedUntil: null } });
  const vaultSession = signVaultSession(req.auth!.recordId, Number(record.sessionVersion ?? 0));
  res.json({ vaultSession, expiresInSeconds: 900 });
}));

credentialVaultRouter.post('/change-pin', requireVaultUnlock, asyncHandler(async (req, res) => {
  const { currentPin, newPin } = changePinSchema.parse(req.body);
  const record: any = await pinModel.findOne({ userId: req.auth!.legacyId }).lean().exec();
  if (!record || !await bcrypt.compare(currentPin, String(record.pinHash))) throw new HttpError(401, 'The current six-digit code is incorrect.');
  const pinHash = await bcrypt.hash(newPin, 12);
  const updated = await pinModel.findOneAndUpdate({ userId: req.auth!.legacyId }, { $set: { pinHash, failedAttempts: 0, lockedUntil: null }, $inc: { sessionVersion: 1 } }, { new: true }).lean().exec() as any;
  res.json({ message: 'Your vault code has been changed.', vaultSession: signVaultSession(req.auth!.recordId, Number(updated.sessionVersion)) });
}));

credentialVaultRouter.get('/recipients', requireVaultUnlock, asyncHandler(async (_req, res) => {
  const records = await listRawRecords('users', {}, 5_000);
  const users = records
    .filter((record) => isEligibleRecipient(record.raw))
    .map((record) => ({
      id: Number(record.legacyId ?? record.raw.id),
      name: String(record.raw.name ?? 'Staff member'),
      email: String(record.raw.email ?? ''),
      role: String(record.raw.role ?? 'employee')
    }))
    .filter((user) => Number.isSafeInteger(user.id) && user.id > 0 && user.id !== _req.auth!.legacyId)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ data: users });
}));

credentialVaultRouter.get('/credentials', requireVaultUnlock, asyncHandler(async (req, res) => {
  const rows = await credentialModel.find({ $or: [{ ownerUserId: req.auth!.legacyId }, { sharedWithUserIds: req.auth!.legacyId }] }).sort({ updatedAt: -1 }).limit(1_000).lean();
  const ids = [...new Set(rows.flatMap((row) => [Number(row.ownerUserId), ...row.sharedWithUserIds.map(Number)]))];
  const staff = await staffDirectory(ids);
  res.json({ data: rows.map((row) => presentCredential(row, staff, req.auth!.legacyId)) });
}));

credentialVaultRouter.post('/credentials', requireVaultUnlock, asyncHandler(async (req, res) => {
  const input = credentialInputSchema.parse(req.body);
  const sharedWithUserIds = await validateRecipientIds(input.sharedWithUserIds, req.auth!.legacyId);
  const created = await credentialModel.create({
    ownerUserId: req.auth!.legacyId,
    title: input.title,
    website: input.website,
    usernameCiphertext: encrypt(input.username),
    passwordCiphertext: encrypt(input.password),
    notesCiphertext: encrypt(input.notes),
    sharedWithUserIds
  });
  const staff = await staffDirectory([req.auth!.legacyId, ...sharedWithUserIds]);
  res.status(201).json({ data: presentCredential(created.toObject(), staff, req.auth!.legacyId) });
}));

credentialVaultRouter.patch('/credentials/:credentialId', requireVaultUnlock, asyncHandler(async (req, res) => {
  const input = credentialInputSchema.parse(req.body);
  const record = await findOwnedCredential(routeParam(req.params.credentialId), req.auth!.legacyId);
  const sharedWithUserIds = await validateRecipientIds(input.sharedWithUserIds, req.auth!.legacyId);
  record.title = input.title;
  record.website = input.website;
  record.usernameCiphertext = encrypt(input.username);
  record.passwordCiphertext = encrypt(input.password);
  record.notesCiphertext = encrypt(input.notes);
  record.sharedWithUserIds = sharedWithUserIds;
  await record.save();
  const staff = await staffDirectory([req.auth!.legacyId, ...sharedWithUserIds]);
  res.json({ data: presentCredential(record.toObject(), staff, req.auth!.legacyId) });
}));

credentialVaultRouter.delete('/credentials/:credentialId', requireVaultUnlock, asyncHandler(async (req, res) => {
  const record = await findOwnedCredential(routeParam(req.params.credentialId), req.auth!.legacyId);
  await record.deleteOne();
  res.status(204).end();
}));

async function requireVaultUnlock(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.header('x-credential-vault-session');
  if (!token || !req.auth) {
    res.status(423).json({ error: 'Unlock your Credential Vault to continue.' });
    return;
  }
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (payload.scope !== 'credential-vault' || payload.sub !== req.auth.recordId) throw new Error('invalid vault session');
    const pin = await pinModel.findOne({ userId: req.auth.legacyId }).select({ sessionVersion: 1 }).lean().exec() as any;
    if (!pin || Number(payload.vaultVersion) !== Number(pin.sessionVersion ?? 0)) throw new Error('revoked vault session');
    next();
  } catch {
    res.status(423).json({ error: 'Your vault session expired. Unlock your vault again.' });
  }
}

function signVaultSession(recordId: string, version: number): string {
  return jwt.sign({ sub: recordId, scope: 'credential-vault', vaultVersion: version }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

async function findOwnedCredential(id: string, ownerUserId: number): Promise<any> {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Credential not found.');
  const record = await credentialModel.findOne({ _id: id, ownerUserId });
  if (!record) throw new HttpError(404, 'Credential not found or you do not own it.');
  return record;
}

async function validateRecipientIds(ids: number[], ownerId: number): Promise<number[]> {
  const requested = [...new Set(ids)].filter((id) => id !== ownerId);
  if (!requested.length) return [];
  const available = await listRawRecords('users', { legacyId: { $in: requested } }, requested.length);
  const eligible = new Set(available.filter((user) => isEligibleRecipient(user.raw)).map((user) => Number(user.legacyId ?? user.raw.id)));
  if (requested.some((id) => !eligible.has(id))) throw new HttpError(422, 'One or more selected staff members are unavailable for sharing.');
  return requested;
}

async function staffDirectory(ids: number[]): Promise<Map<number, { name: string; role: string }>> {
  if (!ids.length) return new Map();
  const rows = await listRawRecords('users', { legacyId: { $in: ids } }, ids.length);
  return new Map(rows.map((row) => [Number(row.legacyId ?? row.raw.id), { name: String(row.raw.name ?? 'Staff member'), role: String(row.raw.role ?? 'employee') }]));
}

function isEligibleRecipient(raw: Record<string, unknown>): boolean {
  const status = String(raw.status ?? '').trim().toLowerCase();
  if (['inactive', 'disabled', 'resigned', 'terminated', 'archived'].includes(status)) return false;
  const role = String(raw.role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !role || ['employee', 'remote_staff', 'manager', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'ceo', 'chief_executive_officer', 'chief_executive', 'admin', 'administrator'].includes(role);
}

function presentCredential(row: any, staff: Map<number, { name: string; role: string }>, currentUserId: number) {
  const ownerId = Number(row.ownerUserId);
  return {
    id: String(row._id),
    ownerUserId: ownerId,
    ownerName: staff.get(ownerId)?.name ?? 'Staff member',
    isOwner: ownerId === currentUserId,
    title: String(row.title),
    website: String(row.website ?? ''),
    username: decrypt(String(row.usernameCiphertext)),
    password: decrypt(String(row.passwordCiphertext)),
    notes: decrypt(String(row.notesCiphertext ?? '')),
    sharedWith: (row.sharedWithUserIds as number[]).map((id) => ({ id: Number(id), name: staff.get(Number(id))?.name ?? 'Staff member', role: staff.get(Number(id))?.role ?? 'employee' })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(value: string): string {
  if (!value) return '';
  const [ivPart, tagPart, encryptedPart] = value.split('.');
  // AES-GCM ciphertext is empty for an empty plaintext (for example, a blank
  // username), while the IV and authentication tag are still present.
  if (!ivPart || !tagPart || encryptedPart === undefined) throw new HttpError(500, 'A saved credential could not be decrypted.');
  // Keep reading ciphertext written before the dedicated vault key was configured.
  // New and updated values still use the current primary key via encryptionKey().
  for (const key of decryptionKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedPart, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // Try the next configured legacy key.
    }
  }
  throw new HttpError(500, 'A saved credential could not be decrypted. Check that the vault encryption key has not changed.');
}

function encryptionKey(): Buffer {
  return decryptionKeys()[0]!;
}

function decryptionKeys(): Buffer[] {
  const secrets = [env.CREDENTIAL_VAULT_ENCRYPTION_SECRET, env.SETTINGS_ENCRYPTION_SECRET, env.JWT_ACCESS_SECRET];
  const uniqueSecrets = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))];
  return uniqueSecrets.map((secret) => createHash('sha256').update(secret).digest());
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

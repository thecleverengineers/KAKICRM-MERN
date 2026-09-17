import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { can } from '../services/permissions.js';
import { persistIncomingFile, storedAssetUrl } from '../services/storage.js';
import { clearFast2SmsWhatsAppApiKey, readFast2SmsWhatsAppStatus, saveFast2SmsWhatsAppApiKey } from '../services/fast2smsSettings.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const defaultBranding = {
  site_title: 'KAKI CRM',
  site_subtitle: 'Operations hub',
  logo_url: null as string | null,
  invoice_logo_url: null as string | null,
  invoice_footer: 'Thank you for your business.',
  invoice_accent: '#2f5ea8'
};

const logoUrlSchema = z.string().trim().max(2_000).nullable().optional();
const brandingSchema = z.object({
  site_title: z.string().trim().min(2).max(80).optional(),
  site_subtitle: z.string().trim().max(120).optional(),
  logo_url: logoUrlSchema,
  invoice_logo_url: logoUrlSchema,
  invoice_footer: z.string().trim().max(500).optional(),
  invoice_accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit HEX colour.').optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one branding change.');
const fast2SmsCredentialSchema = z.object({
  apiKey: z.string().trim().min(8, 'Enter a valid Fast2SMS authorization key.').max(1_000)
});

export const settingsRouter = Router();

// Branding is intentionally available without authentication to render the
// selected title and logo on the login screen. It contains no credentials or
// financial data.
settingsRouter.get('/branding', asyncHandler(async (_req, res) => {
  res.json({ data: await readBranding() });
}));

settingsRouter.patch('/branding', requireAuth, requireBrandingManage, asyncHandler(async (req, res) => {
  const input = brandingSchema.parse(req.body);
  res.json({ data: await saveBranding(input, req.auth!.legacyId) });
}));

settingsRouter.post('/branding/logo', requireAuth, requireBrandingManage, upload.single('logo'), asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Select a logo image to upload.');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
    throw new HttpError(400, 'Upload a PNG, JPG, WEBP, or SVG logo.');
  }
  const kind = z.enum(['app', 'invoice']).default('app').parse(req.body.kind);
  const saved = await persistIncomingFile(file, 'branding');
  const field = kind === 'invoice' ? 'invoice_logo_url' : 'logo_url';
  const data = await saveBranding({ [field]: storedAssetUrl(saved.relativePath) }, req.auth!.legacyId);
  res.status(201).json({ data });
}));

// The credential is write-only. Administrators can confirm that it is saved,
// but the API never returns its value after it reaches the server.
settingsRouter.get('/integrations/fast2sms-whatsapp', requireAuth, requireAdminSettingsManage, asyncHandler(async (_req, res) => {
  res.json({ data: await readFast2SmsWhatsAppStatus() });
}));

settingsRouter.put('/integrations/fast2sms-whatsapp', requireAuth, requireAdminSettingsManage, asyncHandler(async (req, res) => {
  const input = fast2SmsCredentialSchema.parse(req.body);
  res.json({ data: await saveFast2SmsWhatsAppApiKey(input.apiKey, req.auth!.legacyId) });
}));

settingsRouter.delete('/integrations/fast2sms-whatsapp', requireAuth, requireAdminSettingsManage, asyncHandler(async (req, res) => {
  res.json({ data: await clearFast2SmsWhatsAppApiKey(req.auth!.legacyId) });
}));

function requireBrandingManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'rbac.manage')) {
    res.status(403).json({ error: 'Only administrators can change organisation branding.' });
    return;
  }
  next();
}

function requireAdminSettingsManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (String(req.auth.role).trim().toLowerCase() !== 'admin' && !can(req.auth, 'rbac.manage')) {
    res.status(403).json({ error: 'Only administrators can manage Fast2SMS credentials.' });
    return;
  }
  next();
}

async function readBranding(): Promise<typeof defaultBranding> {
  const [record] = await listRawRecords('app_settings', { 'raw.key': 'branding' }, 1);
  return normalizeBranding(record?.raw);
}

async function saveBranding(input: Partial<typeof defaultBranding>, userId: number): Promise<typeof defaultBranding> {
  const [record] = await listRawRecords('app_settings', { 'raw.key': 'branding' }, 1);
  const current = normalizeBranding(record?.raw);
  const next = normalizeBranding({ ...current, ...input });
  if (record?.legacyId) {
    await updateLegacyRecord('app_settings', record.legacyId, {
      ...record.raw,
      ...next,
      key: 'branding',
      updated_by: userId,
      updated_at: nowIst()
    });
  } else {
    await createLegacyRecord('app_settings', {
      key: 'branding',
      ...next,
      created_by: userId,
      created_at: nowIst(),
      updated_at: nowIst()
    });
  }
  return next;
}

function normalizeBranding(value: Record<string, unknown> | undefined): typeof defaultBranding {
  return {
    site_title: nonEmpty(value?.site_title, defaultBranding.site_title, 80),
    site_subtitle: nonEmpty(value?.site_subtitle, defaultBranding.site_subtitle, 120),
    logo_url: urlOrNull(value?.logo_url),
    invoice_logo_url: urlOrNull(value?.invoice_logo_url),
    invoice_footer: nonEmpty(value?.invoice_footer, defaultBranding.invoice_footer, 500),
    invoice_accent: /^#[0-9a-fA-F]{6}$/.test(String(value?.invoice_accent ?? '')) ? String(value?.invoice_accent) : defaultBranding.invoice_accent
  };
}

function nonEmpty(value: unknown, fallback: string, max: number): string {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : fallback;
}

function urlOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text && text.length <= 2_000 ? text : null;
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date());
}

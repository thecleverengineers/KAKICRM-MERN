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
  logo_day_url: null as string | null,
  logo_night_url: null as string | null,
  legal_company_name: 'M/s Chishikaki Creative Solutions (OPC) Private Limited',
  company_information: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_website: '',
  invoice_logo_url: null as string | null,
  invoice_footer: 'Thank you for your business.',
  invoice_accent: '#2f5ea8'
};

const logoUrlSchema = z.string().trim().max(2_000).nullable().optional();
const companyTextSchema = z.string().trim().max(2_000).nullable().optional();
const optionalEmailSchema = z.preprocess((value) => typeof value === 'string' && !value.trim() ? null : value, z.string().trim().email().max(180).nullable().optional());
const optionalUrlSchema = z.preprocess((value) => typeof value === 'string' && !value.trim() ? null : value, z.string().trim().url().max(300).nullable().optional());
const brandingSchema = z.object({
  site_title: z.string().trim().min(2).max(80).optional(),
  site_subtitle: z.string().trim().max(120).optional(),
  logo_url: logoUrlSchema,
  logo_day_url: logoUrlSchema,
  logo_night_url: logoUrlSchema,
  legal_company_name: z.string().trim().min(2).max(180).optional(),
  company_information: companyTextSchema,
  company_address: companyTextSchema,
  company_phone: z.string().trim().max(80).nullable().optional(),
  company_email: optionalEmailSchema,
  company_website: optionalUrlSchema,
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
  const kind = z.enum(['app', 'day', 'night', 'invoice']).default('day').parse(req.body.kind);
  const saved = await persistIncomingFile(file, 'branding');
  const logo = storedAssetUrl(saved.relativePath);
  const input = kind === 'invoice'
    ? { invoice_logo_url: logo }
    : kind === 'night'
      ? { logo_night_url: logo }
      : { logo_url: logo, logo_day_url: logo };
  const data = await saveBranding(input, req.auth!.legacyId);
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

async function saveBranding(input: Record<string, unknown>, userId: number): Promise<typeof defaultBranding> {
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
  const legacyLogo = urlOrNull(value?.logo_url);
  const dayLogo = urlOrNull(value?.logo_day_url) ?? legacyLogo;
  return {
    site_title: nonEmpty(value?.site_title, defaultBranding.site_title, 80),
    site_subtitle: nonEmpty(value?.site_subtitle, defaultBranding.site_subtitle, 120),
    logo_url: legacyLogo ?? dayLogo,
    logo_day_url: dayLogo,
    logo_night_url: urlOrNull(value?.logo_night_url),
    legal_company_name: nonEmpty(value?.legal_company_name, defaultBranding.legal_company_name, 180),
    company_information: nullableText(value?.company_information, 2_000),
    company_address: nullableText(value?.company_address, 2_000),
    company_phone: nullableText(value?.company_phone, 80),
    company_email: nullableText(value?.company_email, 180),
    company_website: nullableText(value?.company_website, 300),
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

function nullableText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date());
}

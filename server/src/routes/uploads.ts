import path from 'node:path';
import { Router, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { openStoredFile } from '../services/storage.js';
import { asyncHandler } from '../utils/http.js';

export const uploadsRouter = Router();

function imageContentType(absolutePath: string): string {
  switch (path.extname(absolutePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

async function sendPublicImage(res: Response, relativePath: string): Promise<void> {
  const stored = await openStoredFile(relativePath);
  res.setHeader('Content-Type', stored.contentType ?? imageContentType(stored.fileName));
  res.setHeader('Content-Disposition', `inline; filename="${stored.fileName.replaceAll('"', '')}"`);
  res.setHeader('Cache-Control', 'public, max-age=300');
  stored.stream.pipe(res);
}

// The sign-in screen and printed invoices need to render their selected
// organisation/company logos before a browser can attach API headers. Only
// these dedicated image directories are public; all other stored files remain
// authenticated.
uploadsRouter.get('/modern/branding/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/branding/${filename}`);
}));

// Profile avatars are rendered by the shell before a component can attach an
// Authorization header. Keep this public route limited to the profile-images
// directory; all other stored files remain protected below.
uploadsRouter.get('/modern/profile-images/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/profile-images/${filename}`);
}));

uploadsRouter.get('/modern/billing-profile-logos/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/billing-profile-logos/${filename}`);
}));

// The selected company profile's authority signature is part of an invoice and
// must load in the browser print preview before API authorization headers can
// be attached. Keep this narrow, printable asset directory public only.
uploadsRouter.get('/modern/billing-profile-signatures/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/billing-profile-signatures/${filename}`);
}));

uploadsRouter.get('/modern/billing-profile-qr-primary/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/billing-profile-qr-primary/${filename}`);
}));

uploadsRouter.get('/modern/billing-profile-qr-secondary/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `modern/billing-profile-qr-secondary/${filename}`);
}));

// Migrated company profiles retain their original `company_logo_path` values,
// which are normalised by the client to this legacy location. Expose only this
// logo directory so invoices can render it without broadening access to other
// historical uploads.
uploadsRouter.get('/legacy/uploads/billing_profiles/*', asyncHandler(async (req, res) => {
  const filename = String(req.params[0] ?? '');
  await sendPublicImage(res, `legacy/uploads/billing_profiles/${filename}`);
}));

uploadsRouter.use(requireAuth);

uploadsRouter.get('/*', asyncHandler(async (req, res) => {
  const relativePath = String(req.params[0] ?? '');
  const stored = await openStoredFile(relativePath);
  res.setHeader('Content-Type', stored.contentType ?? imageContentType(stored.fileName));
  res.setHeader('Content-Disposition', `inline; filename="${stored.fileName.replaceAll('"', '')}"`);
  stored.stream.pipe(res);
}));

import { apiUrl } from './api.js';

/** Convert the stored modern/legacy asset paths into browser-safe API URLs. */
export function assetUrl(value: unknown): string | null {
  const source = String(value ?? '').trim();
  if (!source) return null;
  if (/^(https?:)?\/\//i.test(source) || source.startsWith('data:')) return source;
  if (source.startsWith('/api/')) return source;

  const normalized = source.replace(/^\/+/, '');
  if (normalized.startsWith('modern/')) return apiUrl(`/uploads/${normalized}`);
  if (normalized.startsWith('uploads/') || normalized.startsWith('storage/') || normalized.startsWith('public/uploads/') || normalized.startsWith('public/logo/')) {
    return apiUrl(`/uploads/legacy/${normalized}`);
  }
  return source;
}

export function billingProfileAssetValue(fields: Record<string, unknown>, asset: 'logo' | 'signature' | 'qrPrimary' | 'qrSecondary'): unknown {
  if (asset === 'logo') return first(fields.logo_url, fields.invoice_logo_url, fields.company_logo_path, fields.logo);
  if (asset === 'signature') return first(fields.signature_url, fields.authority_signature_url, fields.authorised_signature_url, fields.signature_file, fields.signature);
  if (asset === 'qrPrimary') return first(fields.qr_code_primary_url, fields.qr_primary_url, fields.qr_code_primary, fields.qr_primary, fields.qrcode_primary);
  return first(fields.qr_code_secondary_url, fields.qr_secondary_url, fields.qr_code_secondary, fields.qr_secondary, fields.qrcode_secondary);
}

/** Secondary QR artwork is previewable on the profile, but is opt-in for invoices and print/PDF output. */
export function billingProfileSecondaryQrEnabled(fields: Record<string, unknown>): boolean {
  const value = first(
    fields.qr_code_secondary_enabled,
    fields.qr_secondary_enabled,
    fields.secondary_qr_enabled,
    fields.secondary_qr_code_enabled
  );
  if (value === null || value === undefined || value === '') return false;
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'enabled', 'on'].includes(String(value).trim().toLowerCase());
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined && String(value).trim()) ?? null;
}

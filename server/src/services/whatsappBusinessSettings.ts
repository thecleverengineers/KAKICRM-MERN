import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';
import { HttpError } from '../utils/http.js';

const SETTINGS_KEY = 'whatsapp_business_cloud';

export interface WhatsAppBusinessStatus {
  configured: boolean;
  connected: boolean;
  verifiedName: string | null;
  displayPhoneNumber: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
}

interface VerifiedPhone {
  verifiedName: string | null;
  displayPhoneNumber: string | null;
}

export async function readWhatsAppBusinessStatus(): Promise<WhatsAppBusinessStatus> {
  const record = await readSettingsRecord();
  const raw = record?.raw;
  const configured = Boolean(raw && hasEncryptedField(raw.access_token_ciphertext, raw.access_token_iv, raw.access_token_tag)
    && hasEncryptedField(raw.phone_number_id_ciphertext, raw.phone_number_id_iv, raw.phone_number_id_tag));
  return {
    configured,
    connected: configured && raw?.connection_status === 'connected',
    verifiedName: safeText(raw?.verified_name),
    displayPhoneNumber: safeText(raw?.display_phone_number),
    updatedAt: record ? String(raw?.updated_at ?? record.updatedAt.toISOString()) : null,
    lastVerifiedAt: safeText(raw?.last_verified_at)
  };
}

export async function connectWhatsAppBusiness(accessToken: string, phoneNumberId: string, updatedBy: number): Promise<WhatsAppBusinessStatus> {
  const verified = await verifyWhatsAppBusinessCredentials(accessToken, phoneNumberId);
  const token = encrypt(accessToken);
  const phoneId = encrypt(phoneNumberId);
  const now = nowIst();
  const record = await readSettingsRecord();
  const fields = {
    key: SETTINGS_KEY,
    access_token_ciphertext: token.ciphertext,
    access_token_iv: token.iv,
    access_token_tag: token.tag,
    phone_number_id_ciphertext: phoneId.ciphertext,
    phone_number_id_iv: phoneId.iv,
    phone_number_id_tag: phoneId.tag,
    credential_version: 1,
    connection_status: 'connected',
    verified_name: verified.verifiedName,
    display_phone_number: verified.displayPhoneNumber,
    updated_by: updatedBy,
    updated_at: now,
    configured_at: now,
    last_verified_at: now,
    last_error: null
  };
  if (record?.legacyId) await updateLegacyRecord('app_settings', record.legacyId, fields);
  else await createLegacyRecord('app_settings', { ...fields, created_by: updatedBy, created_at: now });
  return readWhatsAppBusinessStatus();
}

export async function verifySavedWhatsAppBusinessConnection(updatedBy: number): Promise<WhatsAppBusinessStatus> {
  const record = await readSettingsRecord();
  if (!record || !hasEncryptedField(record.raw.access_token_ciphertext, record.raw.access_token_iv, record.raw.access_token_tag)
    || !hasEncryptedField(record.raw.phone_number_id_ciphertext, record.raw.phone_number_id_iv, record.raw.phone_number_id_tag)) {
    throw new HttpError(409, 'Connect a WhatsApp Business account first.');
  }
  let accessToken: string;
  let phoneNumberId: string;
  try {
    accessToken = decrypt(record.raw.access_token_ciphertext, record.raw.access_token_iv, record.raw.access_token_tag);
    phoneNumberId = decrypt(record.raw.phone_number_id_ciphertext, record.raw.phone_number_id_iv, record.raw.phone_number_id_tag);
  } catch {
    throw new HttpError(500, 'The saved WhatsApp connection could not be opened. Reconnect the account to save fresh credentials.');
  }
  const verified = await verifyWhatsAppBusinessCredentials(accessToken, phoneNumberId);
  const now = nowIst();
  await updateLegacyRecord('app_settings', record.legacyId!, {
    ...record.raw,
    key: SETTINGS_KEY,
    connection_status: 'connected',
    verified_name: verified.verifiedName,
    display_phone_number: verified.displayPhoneNumber,
    last_verified_at: now,
    updated_by: updatedBy,
    updated_at: now,
    last_error: null
  });
  return readWhatsAppBusinessStatus();
}

export async function disconnectWhatsAppBusiness(updatedBy: number): Promise<WhatsAppBusinessStatus> {
  const record = await readSettingsRecord();
  if (record?.legacyId) {
    const now = nowIst();
    await updateLegacyRecord('app_settings', record.legacyId, {
      ...record.raw,
      key: SETTINGS_KEY,
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_tag: null,
      phone_number_id_ciphertext: null,
      phone_number_id_iv: null,
      phone_number_id_tag: null,
      connection_status: 'disconnected',
      disconnected_by: updatedBy,
      disconnected_at: now,
      updated_by: updatedBy,
      updated_at: now
    });
  }
  return readWhatsAppBusinessStatus();
}

async function verifyWhatsAppBusinessCredentials(accessToken: string, phoneNumberId: string): Promise<VerifiedPhone> {
  const url = new URL(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}`);
  url.searchParams.set('fields', 'display_phone_number,verified_name');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw new HttpError(502, 'Meta could not be reached to verify the WhatsApp Business connection. Try again.');
  }
  if (!response.ok) {
    throw new HttpError(422, 'Meta rejected the token or phone number ID. Check that the token has WhatsApp Business permissions and that the ID belongs to the connected business account.');
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !String(body.id ?? '').trim()) {
    throw new HttpError(422, 'Meta did not return a WhatsApp Business phone number for these credentials.');
  }
  return {
    verifiedName: safeText(body.verified_name),
    displayPhoneNumber: safeText(body.display_phone_number)
  };
}

async function readSettingsRecord() {
  const [record] = await listRawRecords('app_settings', { 'raw.key': SETTINGS_KEY }, 1);
  return record ?? null;
}

function encrypt(value: string): { ciphertext: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decrypt(ciphertextValue: unknown, ivValue: unknown, tagValue: unknown): string {
  const ciphertext = safeText(ciphertextValue);
  const iv = safeText(ivValue);
  const tag = safeText(tagValue);
  if (!ciphertext || !iv || !tag) throw new Error('Missing encrypted WhatsApp credential fields.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function encryptionKey(): Buffer {
  const secret = env.WHATSAPP_BUSINESS_ENCRYPTION_SECRET ?? env.SETTINGS_ENCRYPTION_SECRET ?? env.JWT_ACCESS_SECRET;
  return crypto.createHash('sha256').update(`kaki-crm/whatsapp-business/v1:${secret}`).digest();
}

function hasEncryptedField(ciphertext: unknown, iv: unknown, tag: unknown): boolean {
  return Boolean(safeText(ciphertext) && safeText(iv) && safeText(tag));
}

function safeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

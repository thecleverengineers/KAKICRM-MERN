import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';

const SETTINGS_KEY = 'fast2sms_whatsapp';

export interface Fast2SmsWhatsAppConfiguration {
  apiKey: string;
  apiUrl: string;
  messageId: string;
  phoneNumberId: string;
}

export interface Fast2SmsWhatsAppStatus {
  configured: boolean;
  source: 'settings' | 'environment' | 'not_configured';
  storedCredential: boolean;
  templateName: string;
  messageId: string;
  phoneNumberId: string;
  senderNumber: string;
  apiUrl: string;
  updatedAt: string | null;
}

/**
 * Resolves the database-backed administrator credential first, then falls
 * back to a deployment environment variable. It is intentionally read at
 * send-time, so an administrator's saved change takes effect immediately.
 */
export async function readFast2SmsWhatsAppConfiguration(): Promise<Fast2SmsWhatsAppConfiguration | null> {
  const record = await readSettingsRecord();
  const storedKey = record ? decryptStoredApiKey(record.raw) : null;
  const apiKey = storedKey ?? env.FAST2SMS_WHATSAPP_API_KEY ?? env.FAST2SMS_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    apiUrl: env.FAST2SMS_WHATSAPP_API_URL,
    messageId: env.FAST2SMS_WHATSAPP_MESSAGE_ID,
    phoneNumberId: env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID
  };
}

export async function readFast2SmsWhatsAppStatus(): Promise<Fast2SmsWhatsAppStatus> {
  const record = await readSettingsRecord();
  const storedKey = record ? decryptStoredApiKey(record.raw) : null;
  const environmentKey = env.FAST2SMS_WHATSAPP_API_KEY ?? env.FAST2SMS_API_KEY;
  return {
    configured: Boolean(storedKey || environmentKey),
    source: storedKey ? 'settings' : environmentKey ? 'environment' : 'not_configured',
    storedCredential: Boolean(storedKey),
    templateName: env.FAST2SMS_WHATSAPP_TEMPLATE_NAME,
    messageId: env.FAST2SMS_WHATSAPP_MESSAGE_ID,
    phoneNumberId: env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID,
    senderNumber: env.FAST2SMS_WHATSAPP_SENDER_NUMBER,
    apiUrl: env.FAST2SMS_WHATSAPP_API_URL,
    updatedAt: record ? String(record.raw.updated_at ?? record.updatedAt.toISOString()) : null
  };
}

export async function saveFast2SmsWhatsAppApiKey(apiKey: string, updatedBy: number): Promise<Fast2SmsWhatsAppStatus> {
  const encrypted = encryptApiKey(apiKey);
  const now = nowIst();
  const record = await readSettingsRecord();
  const fields = {
    key: SETTINGS_KEY,
    api_key_ciphertext: encrypted.ciphertext,
    api_key_iv: encrypted.iv,
    api_key_tag: encrypted.tag,
    credential_version: 1,
    updated_by: updatedBy,
    updated_at: now,
    configured_at: now
  };
  if (record?.legacyId) await updateLegacyRecord('app_settings', record.legacyId, fields);
  else await createLegacyRecord('app_settings', { ...fields, created_by: updatedBy, created_at: now });
  return readFast2SmsWhatsAppStatus();
}

export async function clearFast2SmsWhatsAppApiKey(updatedBy: number): Promise<Fast2SmsWhatsAppStatus> {
  const record = await readSettingsRecord();
  if (record?.legacyId) {
    await updateLegacyRecord('app_settings', record.legacyId, {
      key: SETTINGS_KEY,
      api_key_ciphertext: null,
      api_key_iv: null,
      api_key_tag: null,
      cleared_by: updatedBy,
      cleared_at: nowIst(),
      updated_by: updatedBy,
      updated_at: nowIst()
    });
  }
  return readFast2SmsWhatsAppStatus();
}

async function readSettingsRecord() {
  const [record] = await listRawRecords('app_settings', { 'raw.key': SETTINGS_KEY }, 1);
  return record ?? null;
}

function encryptApiKey(apiKey: string): { ciphertext: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptStoredApiKey(fields: Record<string, unknown>): string | null {
  const ciphertext = text(fields.api_key_ciphertext);
  const iv = text(fields.api_key_iv);
  const tag = text(fields.api_key_tag);
  if (!ciphertext || !iv || !tag) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8').trim();
    return plain || null;
  } catch (error) {
    console.error('[KAKI CRM] Fast2SMS credential could not be decrypted. Save it again from Settings.', error instanceof Error ? error.message : error);
    return null;
  }
}

function encryptionKey(): Buffer {
  const secret = env.SETTINGS_ENCRYPTION_SECRET ?? env.JWT_ACCESS_SECRET;
  return crypto.createHash('sha256').update(`kaki-crm/fast2sms/v1:${secret}`).digest();
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

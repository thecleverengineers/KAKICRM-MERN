#!/usr/bin/env node
// Uploads encrypted KAKI CRM recovery files to the CEO/Admin-selected Drive folder.
import crypto from 'node:crypto';
import path from 'node:path';
import { open, stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const APP_DIR = path.resolve(process.env.APP_DIR || process.cwd());
dotenv.config({ path: path.join(APP_DIR, '.env') });

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const CHUNK_BYTES = 8 * 1024 * 1024;
const [command, ...fileArguments] = process.argv.slice(2);

if (command !== 'upload' || !fileArguments.length || !process.env.MONGODB_URI) {
  console.error('Usage: MONGODB_URI=... google-drive-backup.mjs upload FILE [FILE ...]');
  process.exit(2);
}

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000, maxPoolSize: 3 });
const db = mongoose.connection.db;
if (!db) throw new Error('MongoDB connection did not expose a database.');
const settingsCollection = db.collection('app_settings');
const integrationsCollection = db.collection('google_integrations');
let backupSetting;

try {
  backupSetting = await settingsCollection.findOne({ 'raw.key': 'backup_google_drive', 'raw.active': true, archivedAt: { $exists: false } });
  if (!backupSetting?.raw?.folder_id || !backupSetting.raw.owner_user_id) {
    console.error('No CEO/Admin Google Drive backup folder is connected.');
    process.exitCode = 3;
  } else {
    const integration = await integrationsCollection.findOne({ 'raw.user_id': Number(backupSetting.raw.owner_user_id), 'raw.connected': true, archivedAt: { $exists: false } });
    if (!integration) throw new Error('The connected Google account is unavailable. Reconnect it from Backup & Restore.');
    const scopes = Array.isArray(integration.raw.scopes) ? integration.raw.scopes.map(String) : [];
    if (!scopes.includes(DRIVE_SCOPE)) throw new Error('The connected Google account has not granted Drive backup permission. Reconnect it.');
    const token = await validAccessToken(integration);
    const files = [];
    for (const argument of fileArguments) {
      const filePath = path.resolve(argument);
      const result = await uploadFile(token, String(backupSetting.raw.folder_id), filePath);
      files.push(result);
      console.log(`Google Drive uploaded ${path.basename(filePath)} (${result.id}).`);
    }
    const retentionDays = boundedInteger(process.env.BACKUP_DRIVE_RETENTION_DAYS, 180, 7, 3650);
    await pruneOldFiles(token, String(backupSetting.raw.folder_id), retentionDays, new Set(files.map((file) => file.id)));
    await settingsCollection.updateOne({ _id: backupSetting._id }, { $set: {
      'raw.last_success_at': new Date().toISOString(),
      'raw.last_file_name': path.basename(path.resolve(fileArguments[0])),
      'raw.last_file_id': files[0]?.id ?? null,
      'raw.last_error': null,
      'raw.updated_at': new Date().toISOString(),
      updatedAt: new Date()
    } });
  }
} catch (error) {
  const message = safeMessage(error);
  if (backupSetting?._id) {
    await settingsCollection.updateOne({ _id: backupSetting._id }, { $set: { 'raw.last_error': message, 'raw.last_failure_at': new Date().toISOString(), 'raw.updated_at': new Date().toISOString(), updatedAt: new Date() } }).catch(() => undefined);
  }
  console.error(`Google Drive backup failed: ${message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

async function validAccessToken(integration) {
  const current = decrypt(integration.raw.encrypted_access_token);
  const expiry = new Date(String(integration.raw.token_expiry || '')).getTime();
  if (current && Number.isFinite(expiry) && expiry > Date.now() + 120_000) return current;
  const refreshToken = decrypt(integration.raw.encrypted_refresh_token);
  if (!refreshToken) throw new Error('The Google refresh token is missing. Reconnect the Google account.');
  const oauthSetting = await settingsCollection.findOne({ 'raw.key': 'google_oauth', archivedAt: { $exists: false } });
  const clientId = text(oauthSetting?.raw?.client_id) || text(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = decrypt(oauthSetting?.raw?.client_secret_ciphertext) || text(process.env.GOOGLE_CLIENT_SECRET);
  if (!clientId || !clientSecret) throw new Error('Google OAuth client configuration is missing.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== 'string') throw new Error('Google authorization expired or was revoked. Reconnect the Google account.');
  const accessToken = String(payload.access_token);
  await integrationsCollection.updateOne({ _id: integration._id }, { $set: {
    'raw.encrypted_access_token': encrypt(accessToken),
    'raw.token_expiry': new Date(Date.now() + Number(payload.expires_in || 3600) * 1000).toISOString(),
    'raw.last_error': null,
    'raw.updated_at': new Date().toISOString(),
    updatedAt: new Date()
  } });
  return accessToken;
}

async function uploadFile(token, folderId, filePath) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`Backup component is not a regular file: ${filePath}`);
  const name = path.basename(filePath);
  const existing = await findExistingFile(token, folderId, name);
  const metadata = {
    name,
    mimeType: 'application/octet-stream',
    appProperties: { kakiCrmBackup: 'true', backupFormat: name.endsWith('.gpg') ? 'encrypted-archive' : 'integrity-sidecar' },
    ...(existing ? {} : { parents: [folderId] })
  };
  const endpoint = existing
    ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,createdTime,modifiedTime`
    : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,createdTime,modifiedTime`;
  const sessionResponse = await retryFetch(endpoint, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(details.size)
    },
    body: JSON.stringify(metadata)
  });
  if (!sessionResponse.ok) throw await driveError(sessionResponse, 'Google Drive could not start the resumable upload.');
  const sessionUrl = sessionResponse.headers.get('location');
  assertGoogleUploadUrl(sessionUrl);
  return uploadChunks(sessionUrl, token, filePath, details.size);
}

async function uploadChunks(sessionUrl, token, filePath, size) {
  const handle = await open(filePath, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error('Backup file changed during Google Drive upload.');
      const response = await retryFetch(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
          'Content-Type': 'application/octet-stream'
        },
        body: buffer
      }, true);
      if (response.status === 308) {
        const acknowledged = response.headers.get('range')?.match(/bytes=0-(\d+)/)?.[1];
        offset = acknowledged ? Number(acknowledged) + 1 : offset + length;
        continue;
      }
      if (!response.ok) throw await driveError(response, 'Google Drive upload failed.');
      return response.json();
    }
    throw new Error('Google Drive did not finalize the upload.');
  } finally {
    await handle.close();
  }
}

async function findExistingFile(token, folderId, name) {
  const query = `'${escapeDriveQuery(folderId)}' in parents and name='${escapeDriveQuery(name)}' and trashed=false and appProperties has { key='kakiCrmBackup' and value='true' }`;
  const response = await driveJson(token, 'GET', `/files?q=${encodeURIComponent(query)}&spaces=drive&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return Array.isArray(response.files) && response.files[0]?.id ? String(response.files[0].id) : null;
}

async function pruneOldFiles(token, folderId, retentionDays, protectedIds) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const query = `'${escapeDriveQuery(folderId)}' in parents and trashed=false and appProperties has { key='kakiCrmBackup' and value='true' }`;
  let pageToken = '';
  do {
    const response = await driveJson(token, 'GET', `/files?q=${encodeURIComponent(query)}&spaces=drive&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const file of Array.isArray(response.files) ? response.files : []) {
      if (!file.id || protectedIds.has(String(file.id))) continue;
      const created = new Date(String(file.createdTime || '')).getTime();
      if (Number.isFinite(created) && created < cutoff) await driveJson(token, 'DELETE', `/files/${encodeURIComponent(String(file.id))}?supportsAllDrives=true`);
    }
    pageToken = typeof response.nextPageToken === 'string' ? response.nextPageToken : '';
  } while (pageToken);
}

async function driveJson(token, method, pathname) {
  const response = await retryFetch(`${DRIVE_API}${pathname}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 204) return {};
  if (!response.ok) throw await driveError(response, 'Google Drive request failed.');
  return response.json();
}

async function retryFetch(url, init, acceptResume = false) {
  let lastResponse;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      if (response.ok || (acceptResume && response.status === 308) || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(16_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500)));
  }
  return lastResponse;
}

async function driveError(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : fallback;
  return new Error(`${message} (HTTP ${response.status})`);
}

function encryptionKey() { return crypto.createHash('sha256').update(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || process.env.SETTINGS_ENCRYPTION_SECRET || process.env.JWT_ACCESS_SECRET || '').digest(); }
function encrypt(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.'); }
function decrypt(value) { if (typeof value !== 'string' || !value) return null; try { const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url')); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'); } catch { return null; } }
function assertGoogleUploadUrl(value) { if (!value) throw new Error('Google Drive did not return an upload session.'); const parsed = new URL(value); if (parsed.protocol !== 'https:' || !(parsed.hostname === 'www.googleapis.com' || parsed.hostname.endsWith('.googleapis.com'))) throw new Error('Google Drive returned an untrusted upload endpoint.'); }
function escapeDriveQuery(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function boundedInteger(value, fallback, minimum, maximum) { const parsed = Number(value); return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function safeMessage(error) { const message = error instanceof Error ? error.message : 'Unknown Google Drive error.'; return message.replace(/[\r\n]+/g, ' ').slice(0, 500); }

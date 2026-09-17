import { createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  getGoogleAccessToken,
  integrationStatus,
  loadGoogleOAuthConfig
} from './googleMeet.js';
import { HttpError } from '../utils/http.js';

const BACKUP_DRIVE_SETTINGS_KEY = 'backup_google_drive';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export interface BackupGoogleDriveStatus {
  oauthConfigured: boolean;
  googleConnected: boolean;
  hasDriveScope: boolean;
  connected: boolean;
  accountEmail: string | null;
  ownerUserId: number | null;
  folderId: string | null;
  folderName: string | null;
  folderUrl: string | null;
  connectedAt: string | null;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  lastFileName: string | null;
  lastError: string | null;
}

export interface BackupDriveFolder {
  id: string;
  name: string;
  webViewLink: string | null;
  driveId: string | null;
}

export async function backupGoogleDriveStatus(currentUserId: number): Promise<BackupGoogleDriveStatus> {
  const [setting] = await listRawRecords('app_settings', { 'raw.key': BACKUP_DRIVE_SETTINGS_KEY }, 1);
  const ownerUserId = numeric(setting?.raw.owner_user_id);
  const active = bool(setting?.raw.active);
  const integrationUserId = active && ownerUserId ? ownerUserId : currentUserId;
  const [oauth, integration] = await Promise.all([
    loadGoogleOAuthConfig(),
    integrationStatus(integrationUserId)
  ]);
  const folderId = text(setting?.raw.folder_id);
  const hasDriveScope = integration.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE);
  return {
    oauthConfigured: Boolean(oauth),
    googleConnected: integration.connected,
    hasDriveScope,
    connected: Boolean(active && folderId && integration.connected && hasDriveScope),
    accountEmail: (active ? text(setting?.raw.account_email) : '') || integration.email,
    ownerUserId: active ? ownerUserId : null,
    folderId: folderId || null,
    folderName: text(setting?.raw.folder_name) || null,
    folderUrl: text(setting?.raw.folder_url) || (folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : null),
    connectedAt: text(setting?.raw.connected_at) || null,
    lastTestedAt: text(setting?.raw.last_tested_at) || null,
    lastSuccessAt: text(setting?.raw.last_success_at) || null,
    lastFileName: text(setting?.raw.last_file_name) || null,
    lastError: text(setting?.raw.last_error) || integration.lastError
  };
}

export async function createAndConnectBackupFolder(userId: number, name: string): Promise<BackupGoogleDriveStatus> {
  await requireDriveConnection(userId);
  const token = await getGoogleAccessToken(userId);
  const folder = await driveRequest<BackupDriveFolder>(token, 'POST', '/files?fields=id,name,webViewLink,driveId&supportsAllDrives=true', {
    name: normalizeFolderName(name),
    mimeType: DRIVE_FOLDER_MIME,
    appProperties: { kakiCrmBackupFolder: 'true' }
  });
  if (!folder.id) throw new HttpError(502, 'Google Drive did not return the new folder ID.');
  await saveFolder(userId, folder);
  return backupGoogleDriveStatus(userId);
}

export async function connectBackupFolder(userId: number, folderReference: string): Promise<BackupGoogleDriveStatus> {
  await requireDriveConnection(userId);
  const folderId = extractFolderId(folderReference);
  const token = await getGoogleAccessToken(userId);
  const folder = await driveRequest<BackupDriveFolder & { mimeType?: string; trashed?: boolean }>(token, 'GET', `/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,webViewLink,driveId,trashed&supportsAllDrives=true`);
  if (folder.mimeType !== DRIVE_FOLDER_MIME || folder.trashed) throw new HttpError(400, 'Choose an accessible Google Drive folder.');
  await saveFolder(userId, folder);
  return backupGoogleDriveStatus(userId);
}

export async function listBackupFolders(userId: number): Promise<BackupDriveFolder[]> {
  await requireDriveConnection(userId);
  const token = await getGoogleAccessToken(userId);
  const query = `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and appProperties has { key='kakiCrmBackupFolder' and value='true' }`;
  const response = await driveRequest<{ files?: BackupDriveFolder[] }>(token, 'GET', `/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,driveId)&orderBy=modifiedTime desc&pageSize=100&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return Array.isArray(response.files) ? response.files : [];
}

export async function testBackupGoogleDrive(currentUserId: number): Promise<BackupGoogleDriveStatus> {
  const status = await backupGoogleDriveStatus(currentUserId);
  if (!status.connected || !status.ownerUserId || !status.folderId) throw new HttpError(400, 'Connect a Google Drive backup folder first.');
  const token = await getGoogleAccessToken(status.ownerUserId);
  await driveRequest(token, 'GET', `/files/${encodeURIComponent(status.folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`);
  const marker = await driveRequest<{ id?: string }>(token, 'POST', '/files?fields=id&supportsAllDrives=true', {
    name: `.kaki-crm-write-test-${Date.now()}.txt`,
    mimeType: 'text/plain',
    parents: [status.folderId],
    appProperties: { kakiCrmBackupTest: 'true' }
  });
  if (!marker.id) throw new HttpError(502, 'Google Drive did not confirm write access.');
  await driveRequest(token, 'DELETE', `/files/${encodeURIComponent(marker.id)}?supportsAllDrives=true`);
  await updateSetting({ last_tested_at: nowIso(), last_error: null, updated_at: nowIso() });
  return backupGoogleDriveStatus(currentUserId);
}

export async function disconnectBackupGoogleDrive(userId: number): Promise<BackupGoogleDriveStatus> {
  await updateSetting({ active: false, disconnected_by: userId, disconnected_at: nowIso(), last_error: null, updated_at: nowIso() });
  return backupGoogleDriveStatus(userId);
}

async function requireDriveConnection(userId: number): Promise<void> {
  const integration = await integrationStatus(userId);
  if (!integration.configured) throw new HttpError(503, 'Configure the Google OAuth client in CEO Settings first.');
  if (!integration.connected) throw new HttpError(400, 'Connect your Google account first.');
  if (!integration.scopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) throw new HttpError(400, 'Reconnect Google Drive and approve the requested folder backup permission.');
}

async function saveFolder(userId: number, folder: BackupDriveFolder): Promise<void> {
  const integration = await integrationStatus(userId);
  await updateSetting({
    active: true,
    owner_user_id: userId,
    account_email: integration.email,
    folder_id: folder.id,
    folder_name: folder.name,
    folder_url: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}`,
    drive_id: folder.driveId ?? null,
    connected_at: nowIso(),
    disconnected_at: null,
    last_error: null,
    updated_by: userId,
    updated_at: nowIso()
  }, userId);
}

async function updateSetting(fields: Record<string, unknown>, createdBy?: number): Promise<void> {
  const [existing] = await listRawRecords('app_settings', { 'raw.key': BACKUP_DRIVE_SETTINGS_KEY }, 1);
  if (existing?.legacyId) {
    await updateLegacyRecord('app_settings', existing.legacyId, { key: BACKUP_DRIVE_SETTINGS_KEY, ...fields });
    return;
  }
  await createLegacyRecord('app_settings', { key: BACKUP_DRIVE_SETTINGS_KEY, ...fields, created_by: createdBy ?? null, created_at: nowIso() });
}

async function driveRequest<T = Record<string, unknown>>(token: string, method: string, pathname: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${DRIVE_API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 204) return {} as T;
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === 'string' ? error.message : 'Google Drive request failed.';
    if (response.status === 403) throw new HttpError(403, 'Google Drive denied access. Enable the Drive API, reconnect the account and approve Drive backup permission.');
    if (response.status === 404) throw new HttpError(404, 'The selected Google Drive folder is unavailable or no longer shared with this connection.');
    throw new HttpError(502, message.slice(0, 300));
  }
  return payload as T;
}

function extractFolderId(value: string): string {
  const candidate = value.trim();
  const urlMatch = candidate.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  const id = urlMatch?.[1] ?? (/^[A-Za-z0-9_-]{10,}$/.test(candidate) ? candidate : '');
  if (!id) throw new HttpError(400, 'Enter a valid Google Drive folder URL or folder ID.');
  return id;
}

function normalizeFolderName(value: string): string {
  const name = value.trim().replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ');
  if (!name) return 'KAKI CRM Backups';
  if (name.length > 120) throw new HttpError(400, 'Backup folder name must be 120 characters or fewer.');
  return name;
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function numeric(value: unknown): number | null { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function bool(value: unknown): boolean { return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()); }
function nowIso(): string { return new Date().toISOString(); }

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from '../config/env.js';

export interface BackupItem {
  id: string;
  filename: string;
  createdAt: string;
  size: number;
  trigger: string;
  sha256: string | null;
  cloud: 'uploaded' | 'pending' | 'failed' | 'not_configured' | 'unknown';
  verifiedAt: string | null;
}

export interface BackupState {
  operation: 'idle' | 'backup' | 'restore' | 'verify';
  status: 'idle' | 'running' | 'success' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  backupId?: string;
}

const validArchive = /^kaki-crm-backup-[A-Za-z0-9_.-]+\.tar\.gz\.gpg$/;

mkdirSync(env.backupRoot, { recursive: true, mode: 0o700 });
mkdirSync(path.join(env.backupRoot, 'incoming'), { recursive: true, mode: 0o700 });

export function backupPath(id: string): string {
  if (!validArchive.test(id) || path.basename(id) !== id) throw new Error('Invalid backup identifier.');
  const resolved = path.join(env.backupRoot, id);
  if (!existsSync(resolved)) throw new Error('Backup not found.');
  return resolved;
}

export async function listBackups(): Promise<BackupItem[]> {
  const names = (await readdir(env.backupRoot)).filter((name) => validArchive.test(name));
  const items = await Promise.all(names.map(async (filename) => {
    const archive = path.join(env.backupRoot, filename);
    const details = await stat(archive);
    const metadata = await readJson<Record<string, unknown>>(`${archive}.json`);
    const checksum = await readText(`${archive}.sha256`);
    return {
      id: filename,
      filename,
      createdAt: String(metadata?.createdAt ?? details.mtime.toISOString()),
      size: details.size,
      trigger: String(metadata?.trigger ?? (filename.includes('-imported-') ? 'imported' : 'unknown')),
      sha256: checksum?.trim().split(/\s+/)[0] ?? null,
      cloud: normalizeCloud(metadata?.cloud),
      verifiedAt: typeof metadata?.verifiedAt === 'string' ? metadata.verifiedAt : null
    } satisfies BackupItem;
  }));
  return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readState(): Promise<BackupState> {
  return (await readJson<BackupState>(path.join(env.backupRoot, '.state.json'))) ?? { operation: 'idle', status: 'idle' };
}

export function startBackup(actor: string): number {
  return launch(['create', 'manual', sanitizeActor(actor)]);
}

export function startRestore(id: string, actor: string): number {
  const archive = backupPath(id);
  return launch(['restore', archive, sanitizeActor(actor)]);
}

export function startVerify(id: string, actor: string): number {
  const archive = backupPath(id);
  return launch(['verify', archive, sanitizeActor(actor)]);
}

export async function importBackup(temporaryPath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const digest = await sha256File(temporaryPath);
  const filename = `kaki-crm-backup-${timestamp}-imported-${digest.slice(0, 10)}.tar.gz.gpg`;
  const destination = path.join(env.backupRoot, filename);
  await rename(temporaryPath, destination);
  await writeFile(`${destination}.sha256`, `${digest}  ${filename}\n`, { mode: 0o600 });
  await writeFile(`${destination}.json`, JSON.stringify({ createdAt: new Date().toISOString(), trigger: 'imported', cloud: 'pending' }, null, 2), { mode: 0o600 });
  return filename;
}

export async function removeTemporary(filePath?: string): Promise<void> {
  if (!filePath) return;
  await unlink(filePath).catch(() => undefined);
}

export function systemStatus() {
  return {
    schedule: 'Daily at 5:30 PM',
    timezone: 'Asia/Kolkata',
    encryption: 'AES-256 (GPG authenticated encrypted archive)',
    serverRoot: env.backupRoot,
    localRetention: env.BACKUP_LOCAL_RETENTION_COUNT,
    driveRetentionDays: env.BACKUP_DRIVE_RETENTION_DAYS,
    driveMode: 'CEO/Admin OAuth folder',
    localComputerCopy: 'Use Download to save an encrypted copy on this computer.',
    included: ['MongoDB database and indexes', 'application source and compiled release', '.env and runtime configuration', 'uploads, documents, spreadsheets, PDFs, images and media', 'configured extra data paths'],
    excluded: ['rebuildable node_modules cache', 'temporary files', 'backup archives (prevents recursive copies)']
  };
}

function launch(args: string[]): number {
  if (!existsSync(env.backupEnginePath)) throw new Error('Backup engine is not installed.');
  const child = spawn('/bin/bash', [env.backupEnginePath, ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, APP_DIR: process.cwd(), BACKUP_ROOT: env.backupRoot }
  });
  child.unref();
  if (!child.pid) throw new Error('Unable to start the backup operation.');
  return child.pid;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filePath, 'utf8')) as T; } catch { return null; }
}

async function readText(filePath: string): Promise<string | null> {
  try { return await readFile(filePath, 'utf8'); } catch { return null; }
}

function sanitizeActor(actor: string): string {
  return actor.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 120) || 'administrator';
}

function normalizeCloud(value: unknown): BackupItem['cloud'] {
  return value === 'uploaded' || value === 'pending' || value === 'failed' || value === 'not_configured' ? value : 'unknown';
}

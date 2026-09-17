import { createReadStream } from 'node:fs';
import { access, cp, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

export async function ensureUploadRoot(): Promise<void> {
  await mkdir(env.uploadRoot, { recursive: true });
}

export function legacyAssetUrl(relativePath: string): string {
  return `/api/uploads/legacy/${relativePath.split(path.sep).join('/')}`;
}

/** URL for files written by the modern application under UPLOAD_ROOT. */
export function storedAssetUrl(relativePath: string): string {
  return `/api/uploads/${relativePath.split(path.sep).join('/')}`;
}

export async function openStoredFile(relativePath: string): Promise<{ stream: ReturnType<typeof createReadStream>; absolutePath: string }> {
  const absolutePath = safeResolveUpload(relativePath);
  try {
    const details = await stat(absolutePath);
    if (!details.isFile()) throw new HttpError(404, 'File not found.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'File not found.');
  }

  return { stream: createReadStream(absolutePath), absolutePath };
}

export async function copyLegacyAssets(legacyRoot: string): Promise<{ copiedRoots: string[]; skippedRoots: string[] }> {
  await ensureUploadRoot();
  const roots = ['uploads', 'storage', 'public/uploads', 'public/logo'];
  const copiedRoots: string[] = [];
  const skippedRoots: string[] = [];

  for (const relativeRoot of roots) {
    const source = path.resolve(legacyRoot, relativeRoot);
    const target = path.resolve(env.uploadRoot, 'legacy', relativeRoot);
    try {
      await access(source);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
      copiedRoots.push(relativeRoot);
    } catch (error) {
      if (isMissing(error)) {
        skippedRoots.push(relativeRoot);
      } else {
        throw error;
      }
    }
  }

  return { copiedRoots, skippedRoots };
}

export function safeResolveUpload(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('../') || normalized === '..') {
    throw new HttpError(400, 'Invalid file path.');
  }
  const target = path.resolve(env.uploadRoot, normalized);
  if (target !== env.uploadRoot && !target.startsWith(`${env.uploadRoot}${path.sep}`)) {
    throw new HttpError(400, 'Invalid file path.');
  }
  return target;
}

export async function persistIncomingFile(file: Express.Multer.File, directory: string): Promise<{ relativePath: string; storedName: string }> {
  const safeDirectory = directory.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!safeDirectory || safeDirectory.includes('../')) throw new HttpError(400, 'Invalid upload directory.');
  const originalName = safeFileName(file.originalname || 'upload');
  const storedName = `${Date.now()}-${randomSuffix()}-${originalName}`;
  const relativePath = path.posix.join('modern', safeDirectory, storedName);
  const absolutePath = safeResolveUpload(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, file.buffer, { flag: 'wx' });
  return { relativePath, storedName };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

function safeFileName(value: string): string {
  const extension = path.extname(value).slice(0, 16);
  const base = path.basename(value, extension).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
  return `${base}${extension.replace(/[^a-zA-Z0-9.]+/g, '')}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

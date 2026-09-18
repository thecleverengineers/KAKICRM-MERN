import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

export type StoredFile = {
  stream: Readable;
  /** Local absolute path, or the logical GridFS filename when stored remotely. */
  absolutePath: string;
  fileName: string;
  contentType?: string;
};

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

export async function openStoredFile(relativePath: string): Promise<StoredFile> {
  const absolutePath = safeResolveUpload(relativePath);

  // GridFS is checked first so a fresh Render instance can serve existing
  // media even though its local filesystem starts empty on every deploy.
  const gridFile = await findGridFile(relativePath);
  if (gridFile) {
    const metadata = gridFile.metadata as Record<string, unknown> | undefined;
    return {
      stream: getGridFsBucket().openDownloadStream(gridFile._id),
      absolutePath: gridFile.filename,
      fileName: path.basename(gridFile.filename),
      contentType: typeof metadata?.contentType === 'string' ? metadata.contentType : undefined
    };
  }

  try {
    const details = await stat(absolutePath);
    if (!details.isFile()) throw new HttpError(404, 'File not found.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'File not found.');
  }

  return { stream: createReadStream(absolutePath), absolutePath, fileName: path.basename(absolutePath) };
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
  const contentType = file.mimetype || contentTypeForPath(relativePath);

  // The durable copy is written before the optional local mirror. This makes
  // uploads safe on Render's ephemeral filesystem and keeps all existing
  // stored URLs/configuration unchanged.
  try {
    await uploadBufferToGridFs(relativePath, file.buffer, contentType, originalName);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Durable media storage is temporarily unavailable.');
  }

  const absolutePath = safeResolveUpload(relativePath);
  try {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.buffer, { flag: 'wx' });
  } catch (error) {
    // Local storage is only a warm cache. The Atlas/GridFS copy above is the
    // source of truth, so a cache write failure must not lose the upload.
    console.warn('Unable to write local media cache; durable upload succeeded.', error);
  }
  return { relativePath, storedName };
}

/**
 * Copies any media already present in UPLOAD_ROOT into Atlas/GridFS when the
 * service starts. This covers legacy files and gives an existing deployment a
 * safe one-time migration path without changing any URLs in MongoDB.
 */
export async function mirrorLocalUploadsToGridFs(): Promise<{ copied: number; skipped: number }> {
  const files = await listFiles(env.uploadRoot);
  let copied = 0;
  let skipped = 0;

  for (const absolutePath of files) {
    const relativePath = path.relative(env.uploadRoot, absolutePath).split(path.sep).join('/');
    if (!relativePath || await findGridFile(relativePath)) {
      skipped += 1;
      continue;
    }

    const upload = getGridFsBucket().openUploadStream(relativePath, {
      contentType: contentTypeForPath(relativePath),
      metadata: { relativePath, contentType: contentTypeForPath(relativePath), source: 'local-media-mirror' }
    });
    await pipeline(createReadStream(absolutePath), upload);
    copied += 1;
  }

  return { copied, skipped };
}

function getGridFsBucket(): mongoose.mongo.GridFSBucket {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new HttpError(503, 'Durable media storage is temporarily unavailable.');
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: env.MEDIA_GRIDFS_BUCKET });
}

async function findGridFile(relativePath: string): Promise<mongoose.mongo.GridFSFile | null> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return null;
  const bucket = getGridFsBucket();
  return bucket.find({ filename: relativePath }).sort({ uploadDate: -1 }).limit(1).next();
}

async function uploadBufferToGridFs(relativePath: string, buffer: Buffer, contentType: string, originalName: string): Promise<void> {
  const upload = getGridFsBucket().openUploadStream(relativePath, {
    contentType,
    metadata: { relativePath, contentType, originalName, source: 'kaki-crm' }
  });
  await pipeline(Readable.from([buffer]), upload);
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return output;
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(absolutePath));
    else if (entry.isFile()) output.push(absolutePath);
  }
  return output;
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

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}

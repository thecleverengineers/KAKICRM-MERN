import { type FilterQuery, type Model } from 'mongoose';
import {
  assertLegacyCollection,
  getLegacyModel,
  makeCompositeKey,
  type LegacyCollection,
  type LegacyRecord,
  type PublicLegacyRecord
} from '../db/legacy.js';
import { toPublicRecordsWithRelations } from './relationLabels.js';

export interface ListOptions {
  page?: number;
  limit?: number;
  search?: string;
  searchFields?: string[];
  searchMode?: 'all' | 'any';
  sort?: string;
  order?: 'asc' | 'desc';
  filters?: Record<string, string | number | boolean | null>;
  /** Additional database scope applied before pagination and count queries. */
  scope?: FilterQuery<LegacyRecord>;
  includeArchived?: boolean;
  archivedOnly?: boolean;
}

export interface PagedRecords {
  data: PublicLegacyRecord[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export async function listLegacyRecords(collection: LegacyCollection, options: ListOptions = {}): Promise<PagedRecords> {
  const model = getLegacyModel(collection);
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const query = buildQuery(options);
  const sortField = normalizeField(options.sort) ? `raw.${options.sort}` : 'updatedAt';
  const direction = options.order === 'asc' ? 1 : -1;

  const [rows, total] = await Promise.all([
    model.find(query).sort({ [sortField]: direction, legacyId: -1 }).skip((page - 1) * limit).limit(limit).lean<LegacyRecord[]>(),
    model.countDocuments(query)
  ]);

  return {
    data: await toPublicRecordsWithRelations(collection, rows),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  };
}

export async function findLegacyRecord(collection: LegacyCollection, legacyId: number): Promise<LegacyRecord | null> {
  return getLegacyModel(collection).findOne({ legacyId, archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
}

export async function findLegacyRecordByMongoId(collection: LegacyCollection, id: string): Promise<LegacyRecord | null> {
  return getLegacyModel(collection).findOne({ _id: id, archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
}

export async function createLegacyRecord(
  collection: LegacyCollection,
  fields: Record<string, unknown>,
  suppliedLegacyId?: number
): Promise<LegacyRecord> {
  const model = getLegacyModel(collection);
  const legacyId = suppliedLegacyId ?? numeric(fields.id) ?? (await nextLegacyId(model));
  const raw = { ...fields, id: fields.id ?? legacyId };
  const record = await model.create({ legacyId, raw });
  const saved = record.toObject() as LegacyRecord;
  if (collection === 'notifications') {
    void import('./webPush.js').then(({ sendWebPushForNotification }) => sendWebPushForNotification(raw)).catch((error) => {
      console.warn('[KAKI CRM] Unable to queue browser push notification.', error);
    });
  }
  return saved;
}

export async function upsertLegacyRecord(
  collection: LegacyCollection,
  fields: Record<string, unknown>,
  suppliedLegacyId?: number
): Promise<void> {
  const model = getLegacyModel(collection);
  const legacyId = suppliedLegacyId ?? numeric(fields.id);
  const raw = { ...fields };
  const selector = legacyId !== null && legacyId !== undefined
    ? { legacyId }
    : { legacyCompositeKey: makeCompositeKey(collection, raw) };

  await model.updateOne(
    selector,
    {
      $set: {
        ...(legacyId !== null && legacyId !== undefined ? { legacyId } : { legacyCompositeKey: makeCompositeKey(collection, raw) }),
        raw,
        archivedAt: undefined
      }
    },
    { upsert: true }
  );
}

export async function updateLegacyRecord(
  collection: LegacyCollection,
  legacyId: number,
  fields: Record<string, unknown>
): Promise<LegacyRecord | null> {
  const model = getLegacyModel(collection);
  const existing = await model.findOne({ legacyId, archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
  if (!existing) return null;

  const updated = await model.findOneAndUpdate(
    { legacyId },
    { $set: { raw: { ...existing.raw, ...fields, id: existing.raw.id ?? legacyId } } },
    { new: true }
  ).lean<LegacyRecord | null>();

  return updated;
}

export async function archiveLegacyRecord(collection: LegacyCollection, legacyId: number): Promise<boolean> {
  const result = await getLegacyModel(collection).updateOne(
    { legacyId, archivedAt: { $exists: false } },
    { $set: { archivedAt: new Date() } }
  );
  return result.modifiedCount === 1;
}

/**
 * Moves several records to the reversible archive in one operation.  The
 * original raw/imported fields are deliberately left untouched so a restore
 * returns the exact same record, relations, files and task history.
 */
export async function archiveLegacyRecords(collection: LegacyCollection, legacyIds: number[]): Promise<number[]> {
  const ids = normalizedLegacyIds(legacyIds);
  if (!ids.length) return [];

  const model = getLegacyModel(collection);
  const rows = await model
    .find({ legacyId: { $in: ids }, archivedAt: { $exists: false } })
    .select({ legacyId: 1 })
    .lean<Array<Pick<LegacyRecord, 'legacyId'>>>();
  const archivedIds = rows.map((row) => row.legacyId).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (!archivedIds.length) return [];

  await model.updateMany(
    { legacyId: { $in: archivedIds }, archivedAt: { $exists: false } },
    { $set: { archivedAt: new Date() } }
  );
  return archivedIds;
}

/** Restores records that were placed in the reversible archive. */
export async function restoreArchivedLegacyRecords(collection: LegacyCollection, legacyIds: number[]): Promise<number[]> {
  const ids = normalizedLegacyIds(legacyIds);
  if (!ids.length) return [];

  const model = getLegacyModel(collection);
  const rows = await model
    .find({ legacyId: { $in: ids }, archivedAt: { $exists: true } })
    .select({ legacyId: 1 })
    .lean<Array<Pick<LegacyRecord, 'legacyId'>>>();
  const restoredIds = rows.map((row) => row.legacyId).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (!restoredIds.length) return [];

  await model.updateMany(
    { legacyId: { $in: restoredIds }, archivedAt: { $exists: true } },
    { $unset: { archivedAt: 1 } }
  );
  return restoredIds;
}

export async function listRawRecords(
  collection: LegacyCollection,
  filter: FilterQuery<LegacyRecord> = {},
  limit = 200
): Promise<LegacyRecord[]> {
  return getLegacyModel(collection).find({ archivedAt: { $exists: false }, ...filter }).sort({ legacyId: -1 }).limit(limit).lean<LegacyRecord[]>();
}

export async function countLegacyRecords(collection: LegacyCollection, filter: FilterQuery<LegacyRecord> = {}): Promise<number> {
  return getLegacyModel(collection).countDocuments({ archivedAt: { $exists: false }, ...filter });
}

export function collectionFromParam(value: string): LegacyCollection {
  assertLegacyCollection(value);
  return value;
}

function buildQuery(options: ListOptions): FilterQuery<LegacyRecord> {
  const query: FilterQuery<LegacyRecord> = options.archivedOnly
    ? { archivedAt: { $exists: true } }
    : options.includeArchived
      ? {}
      : { archivedAt: { $exists: false } };
  const clauses: FilterQuery<LegacyRecord>[] = [];

  if (options.search?.trim()) {
    const fields = (options.searchFields?.filter(normalizeField) ?? ['name', 'title', 'invoice_no', 'email', 'status']);
    const terms = tokenizeSearch(options.search.trim());
    const termClauses = terms.map((term) => {
      const fieldMatch = term.match(/^([a-zA-Z][a-zA-Z0-9_]*):(.+)$/);
      if (fieldMatch && normalizeField(fieldMatch[1])) {
        return { [`raw.${fieldMatch[1]}`]: new RegExp(escapeRegex(fieldMatch[2]), 'i') };
      }
      const expression = new RegExp(escapeRegex(term), 'i');
      return { $or: fields.map((field) => ({ [`raw.${field}`]: expression })) };
    });
    if (termClauses.length) clauses.push(options.searchMode === 'any' ? { $or: termClauses } : { $and: termClauses });
  }

  for (const [field, value] of Object.entries(options.filters ?? {})) {
    if (normalizeField(field) && value !== undefined && value !== '') {
      clauses.push({ [`raw.${field}`]: value });
    }
  }

  if (clauses.length) query.$and = clauses;
  if (options.scope && Object.keys(options.scope).length) {
    return { $and: [query, options.scope] };
  }
  return query;
}

function normalizeField(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value));
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedLegacyIds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

async function nextLegacyId(model: Model<LegacyRecord>): Promise<number> {
  const [last] = await model.find({}).sort({ legacyId: -1 }).limit(1).lean<LegacyRecord[]>();
  return (last?.legacyId ?? 0) + 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeSearch(value: string): string[] {
  const terms = value.match(/"[^"\\]*(?:\\.[^"\\]*)*"|\S+/g) ?? [];
  return terms.map((term) => term.replace(/^"|"$/g, '').trim()).filter(Boolean).slice(0, 12);
}

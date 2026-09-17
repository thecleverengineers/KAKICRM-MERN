import { Router } from 'express';
import { z } from 'zod';
import { LEGACY_COLLECTIONS, type LegacyCollection } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { hasCollectionAccess } from '../middleware/rbac.js';
import {
  archiveLegacyRecord,
  collectionFromParam,
  countLegacyRecords,
  createLegacyRecord,
  findLegacyRecord,
  listLegacyRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import {
  isRelationLookupCollection,
  listRelationOptions,
  relationTargetsForCollection,
  toPublicRecordWithRelations
} from '../services/relationLabels.js';
import { can, isCeoRole, isEmployeeRole } from '../services/permissions.js';
import { employeeCanAccessTask, taskVisibilityScopeWithRelationships } from '../services/taskAccess.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const payloadSchema = z.object({
  fields: z.record(z.string(), z.unknown()),
  legacyId: z.number().int().positive().optional()
});

export const recordsRouter = Router();
recordsRouter.use(requireAuth);

recordsRouter.get('/collections', asyncHandler(async (req, res) => {
  if (!req.auth?.permissions.includes('*') && !isCeoRole(req.auth!)) {
    throw new HttpError(403, 'Only administrators and the CEO can access the full legacy data archive.');
  }
  const data = await Promise.all(LEGACY_COLLECTIONS.map(async (collection) => ({
    collection,
    count: await countLegacyRecords(collection)
  })));
  res.json({ data });
}));

recordsRouter.get('/lookups/:sourceCollection/:targetCollection', asyncHandler(async (req, res) => {
  const source = collectionParam(req.params.sourceCollection);
  const taskLookupForEmployee = source === 'tasks' && Boolean(req.auth) && isEmployeeRole(req.auth!);
  const projectManagerTaskLookup = source === 'tasks' && Boolean(req.auth) && (can(req.auth!, 'departments.manage') || can(req.auth!, 'projects.manage'));
  if (!hasCollectionAccess(req, source, 'write') && !projectManagerTaskLookup && !taskLookupForEmployee) {
    throw new HttpError(403, 'You do not have permission to use these record lookups.');
  }
  const target = collectionParam(req.params.targetCollection);
  if (!isRelationLookupCollection(target) || !relationTargetsForCollection(source).includes(target)) {
    throw new HttpError(404, 'Lookup collection not found.');
  }
  res.json({ data: await listRelationOptions(target) });
}));

recordsRouter.get('/:collection', asyncHandler(async (req, res) => {
  const collection = requireCollection(req.params.collection, req, 'read');
  const filters = readFilters(req.query.filters);
  const taskScope = collection === 'tasks' && isEmployeeRole(req.auth!)
    ? await taskVisibilityScopeWithRelationships(req.auth!.legacyId)
    : collection === 'meetings' && isEmployeeRole(req.auth!)
      ? meetingVisibilityScope(req.auth!.legacyId)
      : undefined;
  const result = await listLegacyRecords(collection, {
    page: numberQuery(req.query.page, 1),
    limit: numberQuery(req.query.limit, 25),
    search: stringQuery(req.query.search),
    searchFields: csvQuery(req.query.searchFields),
    sort: stringQuery(req.query.sort),
    order: req.query.order === 'asc' ? 'asc' : 'desc',
    filters,
    includeArchived: (req.auth?.permissions.includes('*') || isCeoRole(req.auth!)) && req.query.includeArchived === 'true',
    scope: taskScope
  });
  res.json(result);
}));

recordsRouter.get('/:collection/:legacyId', asyncHandler(async (req, res) => {
  const collection = requireCollection(req.params.collection, req, 'read');
  const legacyId = legacyIdParam(req.params.legacyId);
  const record = await findLegacyRecord(collection, legacyId);
  if (!record) throw new HttpError(404, 'Record not found.');
  if (collection === 'meetings' && isEmployeeRole(req.auth!) && !meetingVisibleTo(record, req.auth!.legacyId)) {
    throw new HttpError(404, 'Record not found.');
  }
  if (collection === 'tasks' && isEmployeeRole(req.auth!) && !(await employeeCanAccessTask(record, req.auth!.legacyId))) {
    throw new HttpError(404, 'Record not found.');
  }
  res.json({ data: await toPublicRecordWithRelations(collection, record) });
}));

recordsRouter.post('/:collection', asyncHandler(async (req, res) => {
  const collection = requireCollection(req.params.collection, req, 'write');
  const payload = payloadSchema.parse(req.body);
  const record = await createLegacyRecord(collection, payload.fields, payload.legacyId);
  res.status(201).json({ data: await toPublicRecordWithRelations(collection, record) });
}));

recordsRouter.patch('/:collection/:legacyId', asyncHandler(async (req, res) => {
  const collection = requireCollection(req.params.collection, req, 'write');
  const payload = payloadSchema.pick({ fields: true }).parse(req.body);
  const record = await updateLegacyRecord(collection, legacyIdParam(req.params.legacyId), payload.fields);
  if (!record) throw new HttpError(404, 'Record not found.');
  res.json({ data: await toPublicRecordWithRelations(collection, record) });
}));

recordsRouter.delete('/:collection/:legacyId', asyncHandler(async (req, res) => {
  const collection = requireCollection(req.params.collection, req, 'write');
  const archived = await archiveLegacyRecord(collection, legacyIdParam(req.params.legacyId));
  if (!archived) throw new HttpError(404, 'Record not found.');
  res.status(204).send();
}));

function requireCollection(value: string | string[] | undefined, req: import('express').Request, mode: 'read' | 'write'): LegacyCollection {
  const collection = collectionParam(value);
  if (!hasCollectionAccess(req, collection, mode)) {
    throw new HttpError(403, 'You do not have permission to access this data.');
  }
  return collection;
}

function collectionParam(value: string | string[] | undefined): LegacyCollection {
  const collectionValue = Array.isArray(value) ? value[0] : value;
  if (!collectionValue) throw new HttpError(404, 'Collection not found.');
  try {
    return collectionFromParam(collectionValue);
  } catch {
    throw new HttpError(404, 'Collection not found.');
  }
}

function legacyIdParam(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid record ID.');
  return parsed;
}

function numberQuery(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function csvQuery(value: unknown): string[] | undefined {
  const raw = stringQuery(value);
  return raw?.split(',').map((item) => item.trim()).filter(Boolean);
}

function readFilters(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, item]) =>
        item === null || ['string', 'number', 'boolean'].includes(typeof item)
      )
    ) as Record<string, string | number | boolean | null>;
  } catch {
    throw new HttpError(400, 'Invalid filters JSON.');
  }
}

function meetingVisibilityScope(userId: number) {
  return { $or: [{ 'raw.organizer_id': userId }, { 'raw.created_by': userId }, { 'raw.user_id': userId }, { 'raw.invitee_ids': userId }, { 'raw.invitees.user_id': userId }, { 'raw.invitees.crm_user': userId }] };
}

function meetingVisibleTo(record: import('../db/legacy.js').LegacyRecord, userId: number): boolean {
  const raw = record.raw;
  const ids = [raw.organizer_id, raw.created_by, raw.user_id, ...(Array.isArray(raw.invitee_ids) ? raw.invitee_ids : []), ...(Array.isArray(raw.invitees) ? raw.invitees.flatMap((value) => value && typeof value === 'object' ? [((value as Record<string, unknown>).user_id ?? (value as Record<string, unknown>).crm_user ?? (value as Record<string, unknown>).crm_user_id)] : []) : [])];
  return ids.some((value) => Number(value) === userId);
}

import type { FilterQuery } from 'mongoose';
import type { LegacyRecord } from '../db/legacy.js';
import { listRawRecords } from './legacyRepository.js';
import { isEmployeeRole, type AuthContext } from './permissions.js';

/**
 * Imported task rows use a few different names for the person responsible for
 * work. Keep the employee access rule in one place so a new route cannot
 * accidentally fall back to an unscoped task query.
 */
const directParticipantFields = [
  'assignee_id', 'assignee_ids', 'assignee_user_id', 'assigned_to', 'assigned_to_id',
  'assigned_user_id', 'assigned_user_ids', 'created_by', 'created_by_id',
  'created_by_user_id', 'creator_id', 'creator_user_id', 'owner_id',
  'owner_user_id', 'lead_user_id', 'mentioned_user_id', 'mentioned_user_ids',
  'mention_user_ids', 'tag_user_id', 'tag_user_ids', 'tagged_user_id',
  'tagged_user_ids', 'tagged_ids'
] as const;

const directOwnerFields = [
  'assignee_id', 'assignee_ids', 'assignee_user_id', 'assigned_to', 'assigned_to_id',
  'assigned_user_id', 'created_by', 'created_by_id', 'created_by_user_id',
  'creator_id', 'creator_user_id', 'owner_id', 'owner_user_id', 'lead_user_id'
] as const;

const userReferenceFields = [
  'user_id', 'userId', 'crm_user', 'crm_user_id', 'employee_id', 'employeeId'
] as const;

const nestedUserReferenceFields = [...userReferenceFields, 'id'] as const;

/**
 * Builds a Mongo scope that matches numeric and string legacy user IDs. Mongo
 * equality also matches an element inside an array, which covers imported
 * assignee/tag lists without exposing arbitrary task rows.
 */
export function taskVisibilityScopeForUser(userId: number): FilterQuery<LegacyRecord> {
  const directOwnerClauses = userClauses(directOwnerFields, userId);
  const directParticipantClauses = userClauses(directParticipantFields, userId);
  return {
    $or: [
      ...directOwnerClauses,
      { $and: [{ $or: directParticipantClauses }, nonConfidentialTaskScope()] }
    ]
  } as FilterQuery<LegacyRecord>;
}

/**
 * Adds task IDs referenced by normalized chat mentions and daily-update tags
 * to the direct task scope. These relationships are separate legacy tables,
 * so they must be resolved before the task list is paginated.
 */
export async function taskVisibilityScopeWithRelationships(userId: number): Promise<FilterQuery<LegacyRecord>> {
  const relatedTaskIds = await relatedTaskIdsForUser(userId);
  const directScope = taskVisibilityScopeForUser(userId);
  if (!relatedTaskIds.length) return directScope;
  return {
    $or: [
      ...((directScope.$or as FilterQuery<LegacyRecord>[]) ?? []),
      { $and: [{ legacyId: { $in: relatedTaskIds } }, nonConfidentialTaskScope()] }
    ]
  } as FilterQuery<LegacyRecord>;
}

/** Returns whether an employee can see a task through ownership or collaboration. */
export async function employeeCanAccessTask(task: LegacyRecord | Record<string, unknown>, userId: number): Promise<boolean> {
  const raw = 'raw' in task && task.raw && typeof task.raw === 'object'
    ? task.raw as Record<string, unknown>
    : task as Record<string, unknown>;
  if (!hasDirectParticipant(raw, userId)) return hasRelationshipAccess(raw, userId);
  return !isConfidentialTaskForIndirectParticipant(raw, userId);
}

/** A task creator/assignee/owner can archive it; mentions and tags are access, not ownership. */
export function employeeOwnsTask(task: LegacyRecord | Record<string, unknown>, userId: number): boolean {
  const raw = 'raw' in task && task.raw && typeof task.raw === 'object'
    ? task.raw as Record<string, unknown>
    : task as Record<string, unknown>;
  return directOwnerFields.some((field) => valueContainsUser(raw[field], userId));
}

/** Task creation is an employee workflow; managers and administrators keep their existing permission path. */
export function canCreateEmployeeTask(auth: AuthContext): boolean {
  return isEmployeeRole(auth);
}

export function taskHasDirectParticipant(task: LegacyRecord | Record<string, unknown>, userId: number): boolean {
  const raw = 'raw' in task && task.raw && typeof task.raw === 'object'
    ? task.raw as Record<string, unknown>
    : task as Record<string, unknown>;
  return hasDirectParticipant(raw, userId);
}

async function relatedTaskIdsForUser(userId: number): Promise<number[]> {
  const userScope = userReferenceScope(userId);
  const [chatMentions, updateTags] = await Promise.all([
    listRawRecords('task_chat_mentions', userScope, 20_000),
    listRawRecords('task_update_tags', userScope, 20_000)
  ]);

  const taskIds = new Set<number>();
  for (const row of [...chatMentions, ...updateTags]) {
    addPositiveId(taskIds, row.raw.task_id);
  }

  const updateIds = updateTags
    .map((row) => positiveId(row.raw.update_id) ?? row.legacyId)
    .filter((value): value is number => value !== null && value !== undefined);
  if (updateIds.length) {
    const updates = await listRawRecords('task_updates', { legacyId: { $in: [...new Set(updateIds)] } }, 20_000);
    for (const update of updates) addPositiveId(taskIds, update.raw.task_id);
  }

  return [...taskIds];
}

async function hasRelationshipAccess(raw: Record<string, unknown>, userId: number): Promise<boolean> {
  const taskId = positiveId(raw.id);
  if (!taskId) return false;

  const userScope = userReferenceScope(userId);
  const [chatMentions, directTags, updates] = await Promise.all([
    listRawRecords('task_chat_mentions', { $and: [{ 'raw.task_id': { $in: [taskId, String(taskId)] } }, userScope] }, 1),
    listRawRecords('task_update_tags', { $and: [{ 'raw.task_id': { $in: [taskId, String(taskId)] } }, userScope] }, 1),
    listRawRecords('task_updates', { 'raw.task_id': { $in: [taskId, String(taskId)] } }, 20_000)
  ]);
  if (chatMentions.length || directTags.length) return !isConfidentialTaskForIndirectParticipant(raw, userId);

  const updateIds = updates.map((update) => update.legacyId).filter((value): value is number => value !== undefined);
  if (!updateIds.length) return false;
  const updateTags = await listRawRecords('task_update_tags', {
    $and: [{ 'raw.update_id': { $in: updateIds } }, userScope]
  }, 1);
  return updateTags.length > 0 && !isConfidentialTaskForIndirectParticipant(raw, userId);
}

function userReferenceScope(userId: number): FilterQuery<LegacyRecord> {
  const clauses = userClauses(userReferenceFields, userId);
  return { $or: clauses } as FilterQuery<LegacyRecord>;
}

function userClauses(fields: readonly string[], userId: number): FilterQuery<LegacyRecord>[] {
  return fields.flatMap((field) => [
    { [`raw.${field}`]: userId },
    { [`raw.${field}`]: String(userId) }
  ]) as FilterQuery<LegacyRecord>[];
}

function nonConfidentialTaskScope(): FilterQuery<LegacyRecord> {
  return {
    $nor: [
      { 'raw.confidential': { $in: [true, 1, 'true', '1', 'yes'] } },
      { 'raw.is_confidential': { $in: [true, 1, 'true', '1', 'yes'] } },
      { 'raw.private': { $in: [true, 1, 'true', '1', 'yes'] } },
      { 'raw.is_private': { $in: [true, 1, 'true', '1', 'yes'] } },
      { 'raw.sensitivity': { $in: ['private', 'confidential', 'restricted'] } },
      { 'raw.visibility': { $in: ['private', 'confidential', 'restricted'] } }
    ]
  } as FilterQuery<LegacyRecord>;
}

function hasDirectParticipant(raw: Record<string, unknown>, userId: number): boolean {
  return directParticipantFields.some((field) => valueContainsUser(raw[field], userId));
}

function valueContainsUser(value: unknown, userId: number): boolean {
  if (Array.isArray(value)) return value.some((entry) => valueContainsUser(entry, userId));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return nestedUserReferenceFields.some((field) => valueContainsUser(object[field], userId));
  }
  return positiveId(value) === userId;
}

function isConfidentialTaskForIndirectParticipant(raw: Record<string, unknown>, userId: number): boolean {
  if (hasDirectOwner(raw, userId)) return false;
  const confidentiality = [raw.confidential, raw.is_confidential, raw.private, raw.is_private]
    .some((value) => value === true || value === 1 || ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase()));
  const sensitivity = String(raw.sensitivity ?? raw.visibility ?? '').trim().toLowerCase();
  return confidentiality || ['private', 'confidential', 'restricted'].includes(sensitivity);
}

function hasDirectOwner(raw: Record<string, unknown>, userId: number): boolean {
  return directOwnerFields.some((field) => valueContainsUser(raw[field], userId));
}

function addPositiveId(target: Set<number>, value: unknown): void {
  const id = positiveId(value);
  if (id) target.add(id);
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

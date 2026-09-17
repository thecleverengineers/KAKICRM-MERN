import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { type LegacyRecord, toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { emitRealtime } from '../realtime.js';
import {
  archiveLegacyRecord,
  archiveLegacyRecords,
  createLegacyRecord,
  findLegacyRecord,
  listLegacyRecords,
  listRawRecords,
  restoreArchivedLegacyRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import { toPublicRecordWithRelations, toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { openStoredFile, persistIncomingFile, legacyAssetUrl } from '../services/storage.js';
import { can, isAdminOrHrRole, isEmployeeRole } from '../services/permissions.js';
import {
  canCreateEmployeeTask,
  employeeCanAccessTask,
  employeeOwnsTask,
  taskVisibilityScopeWithRelationships
} from '../services/taskAccess.js';
import { notifyTaskAssigneesOnWhatsApp } from '../services/taskAssignmentWhatsApp.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

const taskUserIdsSchema = z.preprocess(parseArrayInput, z.array(z.coerce.number().int().positive()).max(50));
const taskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional().nullable(),
  status: z.enum(['pending', 'in_progress', 'review', 'completed', 'blocked']).default('pending'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_date: z.string().max(30).optional().nullable(),
  department_id: z.coerce.number().int().positive().optional().nullable(),
  project_id: z.coerce.number().int().positive().optional().nullable(),
  team_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_ids: taskUserIdsSchema.default([]),
  mentionedUserIds: taskUserIdsSchema.default([]),
  taggedUserIds: taskUserIdsSchema.default([])
});
const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(20_000).optional().nullable(),
  status: z.enum(['pending', 'in_progress', 'review', 'completed', 'blocked']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  due_date: z.string().max(30).optional().nullable(),
  department_id: z.coerce.number().int().positive().optional().nullable(),
  project_id: z.coerce.number().int().positive().optional().nullable(),
  team_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_ids: taskUserIdsSchema.optional(),
  mentionedUserIds: taskUserIdsSchema.optional(),
  taggedUserIds: taskUserIdsSchema.optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one task change.');

const dailyUpdateStatusInputSchema = z.enum(['pending', 'in_progress', 'completed', 'working_on', 'complete', 'do_later', 'blocked', 'review']);
const mentionedUserIdsSchema = z.preprocess(parseArrayInput, z.array(z.coerce.number().int().positive()).max(50));
const updateAttachmentIdsSchema = z.preprocess(parseArrayInput, z.array(z.coerce.number().int().positive()).max(50));
const updateSchema = z.object({
  note: z.string().trim().min(1).max(10_000),
  // Daily progress records intentionally use a simple, employee-friendly
  // workflow. Legacy clients may still send their former values; those are
  // normalised below so historical and new records appear consistently.
  update_status: dailyUpdateStatusInputSchema.default('in_progress'),
  update_priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  completion_date: z.string().max(30).optional().nullable(),
  tagUserIds: mentionedUserIdsSchema.default([])
});
const editUpdateSchema = z.object({
  note: z.string().trim().min(1).max(10_000).optional(),
  update_status: dailyUpdateStatusInputSchema.optional(),
  tagUserIds: mentionedUserIdsSchema.optional(),
  removeAttachmentIds: updateAttachmentIdsSchema.optional()
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  mentionedUserIds: z.array(z.coerce.number().int().positive()).max(50).default([])
});

const taskRecycleSchema = z.object({
  taskIds: z.array(z.coerce.number().int().positive()).min(1).max(100)
});
const taskStatusSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'review', 'completed', 'blocked'])
});

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

/** Employees may create their own work; managers, HR and administrators keep
 * the existing company-wide creation path. */
function requireTaskCreateAccess(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (!req.auth || (!canCreateEmployeeTask(req.auth) && !isAdminOrHrRole(req.auth) && !can(req.auth, 'task.manage'))) {
    res.status(403).json({ error: 'You do not have permission to create tasks.' });
    return;
  }
  next();
}

tasksRouter.get('/', asyncHandler(async (req, res) => {
  const employeeOnly = isEmployeeRole(req.auth!);
  const taskScope = employeeOnly ? await taskVisibilityScopeWithRelationships(req.auth!.legacyId) : undefined;
  const result = await listLegacyRecords('tasks', {
    page: numberQuery(req.query.page, 1),
    limit: numberQuery(req.query.limit, 50),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    searchFields: ['title', 'description', 'status', 'priority'],
    sort: typeof req.query.sort === 'string' ? req.query.sort : 'due_date',
    order: req.query.order === 'asc' ? 'asc' : 'desc',
    // Scope before pagination so the total count and every page follow the
    // same owner/assignee/mention/tag access policy.
    scope: taskScope
  });
  const visible = await Promise.all(result.data.map(async (task) => ({ task, visible: await canSeeTask(req.auth!, task.fields) })));
  res.json({ ...result, data: visible.filter((item) => item.visible).map((item) => item.task) });
}));

tasksRouter.post('/', requireTaskCreateAccess, asyncHandler(async (req, res) => {
  const input = taskSchema.parse(req.body);
  const { mentionedUserIds, taggedUserIds, assignee_ids: requestedAssigneeIds, ...taskFields } = input;
  const [validMentionedUserIds, validTaggedUserIds] = await Promise.all([
    validMentionedUserIdsForTask(mentionedUserIds),
    validMentionedUserIdsForTask(taggedUserIds)
  ]);
  const assigneeIds = await validAssigneeIdsForTask(requestedAssigneeIds, taskFields.assignee_id, isEmployeeRole(req.auth!) ? req.auth!.legacyId : null);
  const assigneeId = assigneeIds[0] ?? null;
  const createdAt = nowIst();
  const record = await createLegacyRecord('tasks', {
    ...taskFields,
    assignee_id: assigneeId,
    assignee_ids: assigneeIds,
    mentioned_user_ids: validMentionedUserIds,
    tagged_user_ids: validTaggedUserIds,
    created_by: req.auth!.legacyId,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: taskFields.status === 'completed' ? createdAt : null
  });
  const collaborationUserIds = taskCollaborationUserIds(record, [...validMentionedUserIds, ...validTaggedUserIds]);
  await notifyUsers(record.legacyId!, collaborationUserIds, req.auth!.legacyId, 'task.assigned', 'You were assigned a task', taskFields.title);
  await notifyTaskAssigneesOnWhatsApp({
    task: record,
    assigneeIds,
    assignedById: req.auth!.legacyId,
    assignedByName: req.auth!.name
  });
  emitRealtime('task:created', { task: toPublicRecord(record) });
  emitRealtime('workflow:changed', { userIds: [req.auth!.legacyId, ...collaborationUserIds], date: todayIst() }, 'workforce');
  res.status(201).json({ data: toPublicRecord(record) });
}));

tasksRouter.patch('/:taskId', asyncHandler(async (req, res) => {
  const id = taskId(req.params.taskId);
  const task = await getVisibleTask(req, id);
  const input = taskPatchSchema.parse(req.body);
  const { mentionedUserIds, taggedUserIds, assignee_ids: requestedAssigneeIds, ...taskFields } = input;
  const changes: Record<string, unknown> = { ...taskFields, updated_at: nowIst() };
  if (mentionedUserIds !== undefined) changes.mentioned_user_ids = await validMentionedUserIdsForTask(mentionedUserIds);
  if (taggedUserIds !== undefined) changes.tagged_user_ids = await validMentionedUserIdsForTask(taggedUserIds);
  if (requestedAssigneeIds !== undefined || input.assignee_id !== undefined) {
    const nextAssigneeIds = await validAssigneeIdsForTask(
      requestedAssigneeIds,
      input.assignee_id,
      null,
      requestedAssigneeIds === undefined && input.assignee_id === null ? [] : undefined
    );
    changes.assignee_ids = nextAssigneeIds;
    changes.assignee_id = nextAssigneeIds[0] ?? null;
  }
  if (input.status !== undefined) changes.completed_at = input.status === 'completed' ? nowIst() : null;
  const previousStatus = normalizedTaskStatus(task.raw.status);
  const record = await updateLegacyRecord('tasks', id, changes);
  if (!record) throw new HttpError(404, 'Task not found.');
  if (requestedAssigneeIds !== undefined || input.assignee_id !== undefined) {
    const previousAssigneeIds = normalizedUserIds(task.raw.assignee_ids, task.raw.assignee_id);
    const newlyAssignedIds = normalizedUserIds(record.raw.assignee_ids, record.raw.assignee_id).filter((userId) => !previousAssigneeIds.includes(userId));
    if (newlyAssignedIds.length) {
      await notifyUsers(id, newlyAssignedIds, req.auth!.legacyId, 'task.assigned', 'You were assigned a task', String(record.raw.title ?? 'Task'));
      await notifyTaskAssigneesOnWhatsApp({ task: record, assigneeIds: newlyAssignedIds, assignedById: req.auth!.legacyId, assignedByName: req.auth!.name });
    }
  }
  if (input.status !== undefined && previousStatus !== input.status) {
    await createLegacyRecord('task_updates', {
      task_id: id,
      user_id: req.auth!.legacyId,
      update_date: todayIst(),
      update_status: updateStatusForTaskStatus(input.status),
      daily_status: updateStatusForTaskStatus(input.status),
      update_priority: String(record.raw.priority ?? 'normal'),
      note: `Task status changed from ${humanizeTaskStatus(previousStatus)} to ${humanizeTaskStatus(input.status)} by ${req.auth!.name}.`,
      completion_date: input.status === 'completed' ? todayIst() : null,
      created_at: nowIst()
    });
  }
  const data = await toPublicRecordWithRelations('tasks', record);
  emitRealtime('task:updated', { task: data, previousStatus, status: record.raw.status }, `task:${id}`);
  emitRealtime('workflow:changed', { userIds: [req.auth!.legacyId, ...taskCollaborationUserIds(record)], date: todayIst() }, 'workforce');
  res.json({ data });
}));

tasksRouter.delete('/:taskId', asyncHandler(async (req, res) => {
  const id = taskId(req.params.taskId);
  const task = await getVisibleTask(req, id);
  const canArchive = isAdminOrHrRole(req.auth!) || can(req.auth!, 'task.manage') || employeeOwnsTask(task, req.auth!.legacyId);
  if (!canArchive) throw new HttpError(403, 'Only the task owner, assignee, or an authorised task manager can archive this task.');
  const archived = await archiveLegacyRecord('tasks', id);
  if (!archived) throw new HttpError(404, 'Task not found.');
  emitRealtime('task:recycled', { taskIds: [id], actorId: req.auth!.legacyId }, 'tasks');
  emitRealtime('workflow:changed', { userIds: [req.auth!.legacyId, ...taskCollaborationUserIds(task)], date: todayIst() }, 'workforce');
  res.status(204).send();
}));

tasksRouter.patch('/:taskId/status', asyncHandler(async (req, res) => {
  const id = taskId(req.params.taskId);
  const task = await getVisibleTask(req, id);
  const input = taskStatusSchema.parse(req.body);
  const previousStatus = normalizedTaskStatus(task.raw.status);
  const changedAt = nowIst();
  const record = await updateLegacyRecord('tasks', id, {
    status: input.status,
    completed_at: input.status === 'completed' ? changedAt : null,
    updated_at: changedAt
  });
  if (!record) throw new HttpError(404, 'Task not found.');

  if (previousStatus !== input.status) {
    await createLegacyRecord('task_updates', {
      task_id: id,
      user_id: req.auth!.legacyId,
      update_date: todayIst(),
      update_status: updateStatusForTaskStatus(input.status),
      daily_status: updateStatusForTaskStatus(input.status),
      update_priority: String(task.raw.priority ?? 'normal'),
      note: `Task status changed from ${humanizeTaskStatus(previousStatus)} to ${humanizeTaskStatus(input.status)} by ${req.auth!.name}.`,
      completion_date: input.status === 'completed' ? todayIst() : null,
      created_at: changedAt
    });
    await notifyUsers(
      id,
      taskCollaborationUserIds(task),
      req.auth!.legacyId,
      'task.status',
      `Task status changed: ${String(task.raw.title ?? 'Task')}`,
      `${req.auth!.name} changed the task status from ${humanizeTaskStatus(previousStatus)} to ${humanizeTaskStatus(input.status)}.`
    );
  }

  const data = await toPublicRecordWithRelations('tasks', record);
  emitRealtime('task:updated', { task: data, previousStatus, status: input.status }, `task:${id}`);
  emitRealtime('workflow:changed', { userIds: [req.auth!.legacyId, ...taskCollaborationUserIds(task)], date: todayIst() }, 'workforce');
  res.json({ data });
}));

tasksRouter.get('/recycle-bin', requirePermission('task.manage'), asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('tasks', {
    page: numberQuery(req.query.page, 1),
    limit: numberQuery(req.query.limit, 50),
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    searchFields: ['title', 'description', 'status', 'priority'],
    archivedOnly: true
  });
  res.json(result);
}));

tasksRouter.post('/recycle', requirePermission('task.manage'), asyncHandler(async (req, res) => {
  const input = taskRecycleSchema.parse(req.body);
  const requestedTaskIds = uniqueTaskIds(input.taskIds);
  const activeTasks = await listRawRecords('tasks', { legacyId: { $in: requestedTaskIds } }, requestedTaskIds.length);
  const recycledTaskIds = await archiveLegacyRecords('tasks', requestedTaskIds);
  if (!recycledTaskIds.length) throw new HttpError(404, 'The selected tasks are already in recycle or no longer exist.');

  emitTaskRecycleChange('recycled', recycledTaskIds, activeTasks, req.auth!.legacyId);
  res.json({ data: { recycledTaskIds, count: recycledTaskIds.length } });
}));

tasksRouter.post('/recycle-bin/restore', requirePermission('task.manage'), asyncHandler(async (req, res) => {
  const input = taskRecycleSchema.parse(req.body);
  const requestedTaskIds = uniqueTaskIds(input.taskIds);
  const restoredTaskIds = await restoreArchivedLegacyRecords('tasks', requestedTaskIds);
  if (!restoredTaskIds.length) throw new HttpError(404, 'The selected tasks are no longer in recycle.');

  const restoredTasks = await listRawRecords('tasks', { legacyId: { $in: restoredTaskIds } }, restoredTaskIds.length);
  emitTaskRecycleChange('restored', restoredTaskIds, restoredTasks, req.auth!.legacyId);
  res.json({ data: { restoredTaskIds, count: restoredTaskIds.length } });
}));

// An @ mention is intentionally scoped to a task the signed-in user can see.
// This supplies only active employee metadata needed for the mention picker,
// rather than exposing the complete generic Users record API.
tasksRouter.get('/:taskId/mentionable-users', asyncHandler(async (req, res) => {
  await getVisibleTask(req, taskId(req.params.taskId));
  const users = await listRawRecords('users', {}, 2_000);
  res.json({
    data: users
      .filter((user) => isActiveUser(user.raw.status))
      .map((user) => ({
        id: user.legacyId,
        name: employeeName(user),
        department: stringValue(user.raw.department) || null,
        designation: stringValue(user.raw.designation) || null
      }))
      .filter((user): user is { id: number; name: string; department: string | null; designation: string | null } => isNumber(user.id))
      .sort((left, right) => left.name.localeCompare(right.name))
  });
}));

tasksRouter.get('/:taskId', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const taskIdValue = task.legacyId!;
  // Daily updates can grow quickly on a long-running task. Keep this endpoint
  // responsive and deliberately return ten updates at a time.
  const [updatesResult, chatOne, chatTwo, followers, timeLogs, taskFiles, updateFiles] = await Promise.all([
    listLegacyRecords('task_updates', {
      page: numberQuery(req.query.updatesPage, 1),
      limit: 10,
      sort: 'created_at',
      order: 'desc',
      scope: { 'raw.task_id': taskIdValue }
    }),
    listRawRecords('task_chat', { 'raw.task_id': taskIdValue }, 500),
    listRawRecords('task_chats', { 'raw.task_id': taskIdValue }, 500),
    listRawRecords('task_followers', { 'raw.task_id': taskIdValue }, 500),
    listRawRecords('task_time_logs', { 'raw.task_id': taskIdValue }, 500),
    listRawRecords('task_files', { 'raw.task_id': taskIdValue }, 10_000),
    // The Files panel brings together direct task files and every attachment
    // posted through daily updates. It has its own pagination below, rather
    // than depending on whichever ten daily updates are currently visible.
    listRawRecords('task_update_files', { 'raw.task_id': taskIdValue }, 10_000)
  ]);
  const [publicChatOne, publicChatTwo] = await Promise.all([
    toPublicRecordsWithRelations('task_chat', chatOne),
    toPublicRecordsWithRelations('task_chats', chatTwo)
  ]);
  const chatIds = [...chatOne, ...chatTwo].map((chat) => chat.legacyId).filter(isNumber);
  const chatMentions = chatIds.length
    ? await listRawRecords('task_chat_mentions', { 'raw.chat_id': { $in: chatIds } }, 5_000)
    : [];
  const mentionedUserIdsByChat = new Map<number, number[]>();
  for (const mention of chatMentions) {
    const chatId = Number(mention.raw.chat_id);
    const userId = Number(mention.raw.user_id);
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) continue;
    const current = mentionedUserIdsByChat.get(chatId) ?? [];
    if (!current.includes(userId)) current.push(userId);
    mentionedUserIdsByChat.set(chatId, current);
  }
  const updateIds = updatesResult.data.map((update) => update.legacyId).filter(isNumber);
  const updateTags = updateIds.length
    ? await listRawRecords('task_update_tags', { 'raw.update_id': { $in: updateIds } }, 2_000)
    : [];
  const mentionedUserIdsByUpdate = new Map<number, number[]>();
  for (const tag of updateTags) {
    const updateId = Number(tag.raw.update_id);
    const mentionedUserId = Number(tag.raw.user_id);
    if (!Number.isSafeInteger(updateId) || updateId <= 0 || !Number.isSafeInteger(mentionedUserId) || mentionedUserId <= 0) continue;
    const current = mentionedUserIdsByUpdate.get(updateId) ?? [];
    if (!current.includes(mentionedUserId)) current.push(mentionedUserId);
    mentionedUserIdsByUpdate.set(updateId, current);
  }
  const attachmentsByUpdate = new Map<number, Array<ReturnType<typeof toPublicRecord> & { kind: 'image' | 'document' }>>();
  for (const attachment of updateFiles) {
    const updateId = Number(attachment.raw.update_id);
    if (!isNumber(updateId)) continue;
    const current = attachmentsByUpdate.get(updateId) ?? [];
    current.push({ ...toPublicRecord(attachment), kind: dailyUpdateAttachmentKind(attachment) });
    attachmentsByUpdate.set(updateId, current);
  }
  const allAttachments = [
    ...taskFiles.map((file) => ({
      ...toPublicRecord(file),
      kind: taskFileKind(file),
      source: 'task_file' as const
    })),
    ...updateFiles.map((file) => ({
      ...toPublicRecord(file),
      kind: dailyUpdateAttachmentKind(file),
      source: 'daily_update' as const,
      updateId: Number(file.raw.update_id)
    }))
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const filesLimit = 10;
  const filesTotal = allAttachments.length;
  const filesPages = Math.max(1, Math.ceil(filesTotal / filesLimit));
  const filesPage = Math.min(numberQuery(req.query.filesPage, 1), filesPages);
  const filesStart = (filesPage - 1) * filesLimit;

  res.json({
    data: await toPublicRecordWithRelations('tasks', task),
    updates: updatesResult.data.map((update) => ({
      ...update,
      mentionedUserIds: mentionedUserIdsByUpdate.get(update.legacyId ?? -1) ?? [],
      attachments: attachmentsByUpdate.get(update.legacyId ?? -1) ?? []
    })),
    updatesPagination: updatesResult.pagination,
    chat: [...publicChatOne, ...publicChatTwo]
      .map((entry) => ({ ...entry, mentionedUserIds: mentionedUserIdsByChat.get(entry.legacyId ?? -1) ?? [] }))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
    followers: await toPublicRecordsWithRelations('task_followers', followers),
    timeLogs: await toPublicRecordsWithRelations('task_time_logs', timeLogs),
    files: allAttachments.slice(filesStart, filesStart + filesLimit),
    filesPagination: { page: filesPage, limit: filesLimit, total: filesTotal, pages: filesPages }
  });
}));

tasksRouter.post('/:taskId/updates', upload.array('files', 10), asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const input = updateSchema.parse(req.body);
  const files = dailyUpdateIncomingFiles(req.files);
  const dailyStatus = normalizedDailyUpdateStatus(input.update_status);
  const mentionedUserIds = await validMentionedUserIds(input.tagUserIds);
  const update = await createLegacyRecord('task_updates', {
    task_id: task.legacyId,
    user_id: req.auth!.legacyId,
    update_date: todayIst(),
    // Keep update_status for compatibility with the existing CRM data while
    // recording an explicit daily_status for new reports and integrations.
    update_status: dailyStatus,
    daily_status: dailyStatus,
    update_priority: input.update_priority,
    completion_date: input.completion_date ?? null,
    note: input.note,
    created_at: nowIst()
  });
  await syncUpdateMentions(update.legacyId!, mentionedUserIds, []);
  const attachments = await createDailyUpdateAttachments(task.legacyId!, update.legacyId!, req.auth!.legacyId, files);
  await notifyUsers(
    task.legacyId!,
    taskCollaborationUserIds(task, mentionedUserIds),
    req.auth!.legacyId,
    'task.update',
    `Daily update on ${String(task.raw.title ?? 'task')}`,
    `${req.auth!.name} posted: ${input.note}`
  );
  emitRealtime('task:update', { taskId: task.legacyId, update: toPublicRecord(update) }, `task:${task.legacyId}`);
  emitRealtime('workflow:changed', {
    userIds: [req.auth!.legacyId, ...taskCollaborationUserIds(task)],
    date: todayIst()
  }, 'workforce');
  res.status(201).json({ data: toPublicRecord(update), attachments: attachments.map((attachment) => ({ ...toPublicRecord(attachment), kind: dailyUpdateAttachmentKind(attachment) })) });
}));

tasksRouter.patch('/:taskId/updates/:updateId', upload.array('files', 10), asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const update = await editableTaskUpdate(req, task, taskId(req.params.updateId));
  const input = editUpdateSchema.parse(req.body);
  const files = dailyUpdateIncomingFiles(req.files);
  if (input.note === undefined && input.update_status === undefined && input.tagUserIds === undefined && !(input.removeAttachmentIds?.length) && !files.length) {
    throw new HttpError(400, 'Provide an update message, status, mentioned employee, or attachment.');
  }
  const nextMentionedUserIds = input.tagUserIds === undefined ? undefined : await validMentionedUserIds(input.tagUserIds);
  const existingMentionedUserIds = await mentionedUsersForUpdate(update.legacyId!);
  const patch: Record<string, unknown> = { updated_at: nowIst(), edited_at: nowIst(), edited_by: req.auth!.legacyId };
  if (input.note !== undefined) patch.note = input.note;
  if (input.update_status !== undefined) {
    const dailyStatus = normalizedDailyUpdateStatus(input.update_status);
    patch.update_status = dailyStatus;
    patch.daily_status = dailyStatus;
  }
  const updated = await updateLegacyRecord('task_updates', update.legacyId!, patch);
  if (!updated) throw new HttpError(404, 'Daily update no longer exists.');
  if (nextMentionedUserIds !== undefined) {
    await syncUpdateMentions(update.legacyId!, nextMentionedUserIds, existingMentionedUserIds);
  }
  if (input.removeAttachmentIds?.length) await archiveDailyUpdateAttachments(update.legacyId!, input.removeAttachmentIds);
  await createDailyUpdateAttachments(task.legacyId!, update.legacyId!, req.auth!.legacyId, files);
  await notifyUsers(
    task.legacyId!,
    taskCollaborationUserIds(task, nextMentionedUserIds ?? existingMentionedUserIds),
    req.auth!.legacyId,
    'task.update',
    `Daily update edited on ${String(task.raw.title ?? 'task')}`,
    `${req.auth!.name} edited: ${String(updated.raw.note ?? '')}`
  );
  emitRealtime('task:update', { taskId: task.legacyId, update: toPublicRecord(updated), action: 'edited' }, `task:${task.legacyId}`);
  res.json({ data: toPublicRecord(updated) });
}));

// Files are served through the task route so each request verifies that the
// signed-in viewer can still access this task. The client fetches these with
// its bearer token before displaying an image or downloading a document.
tasksRouter.get('/:taskId/updates/:updateId/attachments/:attachmentId', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const updateIdValue = taskId(req.params.updateId);
  const update = await findLegacyRecord('task_updates', updateIdValue);
  if (!update || Number(update.raw.task_id) !== task.legacyId) throw new HttpError(404, 'Daily update not found.');
  const attachment = await findLegacyRecord('task_update_files', taskId(req.params.attachmentId));
  if (!attachment || Number(attachment.raw.update_id) !== update.legacyId || Number(attachment.raw.task_id) !== task.legacyId) {
    throw new HttpError(404, 'Update attachment not found.');
  }
  const { stream } = await openStoredFile(dailyUpdateAttachmentStoredPath(attachment));
  const fileName = String(attachment.raw.original_name ?? attachment.raw.stored_name ?? 'attachment').replace(/[\r\n"]/g, '');
  const isImage = dailyUpdateAttachmentKind(attachment) === 'image';
  res.setHeader('Content-Type', dailyUpdateAttachmentContentType(attachment));
  res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${fileName || 'attachment'}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  stream.pipe(res);
}));

// Direct task files use the same authenticated streaming pattern as daily
// update attachments, allowing the Files panel to safely render image and PDF
// previews without exposing a permanent public upload URL.
tasksRouter.get('/:taskId/files/:fileId', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const file = await findLegacyRecord('task_files', taskId(req.params.fileId));
  if (!file || Number(file.raw.task_id) !== task.legacyId) throw new HttpError(404, 'Task file not found.');
  const { stream } = await openStoredFile(taskFileStoredPath(file));
  const fileName = String(file.raw.original_name ?? file.raw.stored_name ?? 'attachment').replace(/[\r\n"]/g, '');
  const isImage = taskFileKind(file) === 'image';
  res.setHeader('Content-Type', taskFileContentType(file));
  res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${fileName || 'attachment'}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  stream.pipe(res);
}));

tasksRouter.delete('/:taskId/updates/:updateId', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const update = await editableTaskUpdate(req, task, taskId(req.params.updateId));
  const tags = await listRawRecords('task_update_tags', { 'raw.update_id': update.legacyId }, 100);
  const tagIds = tags.map((tag) => tag.legacyId).filter(isNumber);
  if (tagIds.length) await archiveLegacyRecords('task_update_tags', tagIds);
  await archiveDailyUpdateAttachments(update.legacyId!, undefined);
  const [archivedUpdateId] = await archiveLegacyRecords('task_updates', [update.legacyId!]);
  if (!archivedUpdateId) throw new HttpError(404, 'Daily update no longer exists.');
  emitRealtime('task:update', { taskId: task.legacyId, updateId: update.legacyId, action: 'deleted' }, `task:${task.legacyId}`);
  res.status(204).send();
}));

tasksRouter.post('/:taskId/chat', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const input = messageSchema.parse(req.body);
  const mentionedUserIds = await validMentionedUserIds(input.mentionedUserIds);
  const chat = await createLegacyRecord('task_chats', {
    task_id: task.legacyId,
    user_id: req.auth!.legacyId,
    message: input.message,
    created_at: nowIst()
  });
  for (const userId of mentionedUserIds) {
    await createLegacyRecord('task_chat_mentions', { chat_id: chat.legacyId, task_id: task.legacyId, user_id: userId, created_at: nowIst() });
  }
  await notifyUsers(
    task.legacyId!,
    taskCollaborationUserIds(task, mentionedUserIds),
    req.auth!.legacyId,
    'task.chat',
    `New task chat message on ${String(task.raw.title ?? 'task')}`,
    `${req.auth!.name}: ${input.message}`
  );
  emitRealtime('task:chat', { taskId: task.legacyId, chat: toPublicRecord(chat) }, `task:${task.legacyId}`);
  res.status(201).json({ data: toPublicRecord(chat) });
}));

tasksRouter.post('/:taskId/followers', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const userId = req.auth!.legacyId;
  const existing = await listRawRecords('task_followers', { 'raw.task_id': task.legacyId, 'raw.user_id': userId }, 1);
  if (!existing.length) {
    await createLegacyRecord('task_followers', { task_id: task.legacyId, user_id: userId, created_at: nowIst() });
  }
  res.status(204).send();
}));

tasksRouter.post('/:taskId/time-logs', asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const input = z.object({ minutes: z.coerce.number().int().min(1).max(1440), note: z.string().max(1_000).optional().nullable(), log_date: z.string().max(30).optional() }).parse(req.body);
  const record = await createLegacyRecord('task_time_logs', {
    task_id: task.legacyId,
    user_id: req.auth!.legacyId,
    minutes: input.minutes,
    note: input.note ?? null,
    log_date: input.log_date ?? todayIst(),
    created_at: nowIst()
  });
  res.status(201).json({ data: toPublicRecord(record) });
}));

tasksRouter.post('/:taskId/files', upload.array('files', 5), asyncHandler(async (req, res) => {
  const task = await getVisibleTask(req, taskId(req.params.taskId));
  const files = req.files;
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'Select at least one file.');
  const stored = await Promise.all(files.map(async (file) => {
    const saved = await persistIncomingFile(file, 'task-files');
    return createLegacyRecord('task_files', {
      task_id: task.legacyId,
      user_id: req.auth!.legacyId,
      original_name: file.originalname,
      stored_name: saved.relativePath,
      mime: file.mimetype,
      size_bytes: file.size,
      created_at: nowIst()
    });
  }));
  res.status(201).json({ data: stored.map((record) => ({ ...toPublicRecord(record), url: fileUrl(record) })) });
}));

async function getVisibleTask(req: import('express').Request, id: number): Promise<LegacyRecord> {
  const task = await findLegacyRecord('tasks', id);
  if (!task) throw new HttpError(404, 'Task not found.');
  if (!(await canSeeTask(req.auth!, task.raw))) throw new HttpError(403, 'You do not have access to this task.');
  return task;
}

/**
 * A daily update is owned by its author. Task managers may moderate every
 * update on a task, while everyone else can only change their own update.
 */
async function editableTaskUpdate(
  req: import('express').Request,
  task: LegacyRecord,
  updateId: number
): Promise<LegacyRecord> {
  const update = await findLegacyRecord('task_updates', updateId);
  if (!update || Number(update.raw.task_id) !== task.legacyId) throw new HttpError(404, 'Daily update not found.');

  const isAuthor = Number(update.raw.user_id) === req.auth!.legacyId;
  if (!isAuthor && !can(req.auth!, 'task.manage') && !req.auth!.permissions.includes('*')) {
    throw new HttpError(403, 'You can edit or remove only your own daily updates.');
  }
  return update;
}

async function mentionedUsersForUpdate(updateId: number): Promise<number[]> {
  const tags = await listRawRecords('task_update_tags', { 'raw.update_id': updateId }, 100);
  return [...new Set(tags
    .map((tag) => Number(tag.raw.user_id))
    .filter((userId) => Number.isSafeInteger(userId) && userId > 0))];
}

/** Replaces the update's mention links so editing never leaves stale tags. */
async function syncUpdateMentions(updateId: number, mentionedUserIds: number[], _previousMentionedUserIds: number[]): Promise<void> {
  const existingTags = await listRawRecords('task_update_tags', { 'raw.update_id': updateId }, 100);
  const existingTagIds = existingTags
    .map((tag) => tag.legacyId)
    .filter(isNumber);
  if (existingTagIds.length) await archiveLegacyRecords('task_update_tags', existingTagIds);

  const createdAt = nowIst();
  for (const userId of [...new Set(mentionedUserIds)]) {
    await createLegacyRecord('task_update_tags', {
      update_id: updateId,
      user_id: userId,
      created_at: createdAt
    });
  }
}

async function validMentionedUserIds(userIds: number[]): Promise<number[]> {
  const normalized = [...new Set(userIds.filter((userId) => Number.isSafeInteger(userId) && userId > 0))];
  if (!normalized.length) return [];

  const users = await listRawRecords('users', { legacyId: { $in: normalized } }, normalized.length);
  const activeIds = new Set(users
    .filter((user) => isActiveUser(user.raw.status))
    .map((user) => user.legacyId)
    .filter(isNumber));
  const unavailableIds = normalized.filter((userId) => !activeIds.has(userId));
  if (unavailableIds.length) throw new HttpError(400, 'One or more selected employees are unavailable.');
  return normalized;
}

async function validMentionedUserIdsForTask(userIds: number[]): Promise<number[]> {
  return validMentionedUserIds(userIds);
}

async function validAssigneeIdsForTask(
  requestedIds: number[] | undefined,
  legacyAssigneeId: number | null | undefined,
  fallbackId: number | null,
  explicitIds?: number[]
): Promise<number[]> {
  const source = explicitIds ?? [
    ...(requestedIds ?? []),
    ...(legacyAssigneeId ? [legacyAssigneeId] : [])
  ];
  const uniqueIds = [...new Set(source.filter((userId) => Number.isSafeInteger(userId) && userId > 0))];
  const resolvedIds = uniqueIds.length ? uniqueIds : (fallbackId ? [fallbackId] : []);
  return validMentionedUserIdsForTask(resolvedIds);
}

function normalizedUserIds(...values: unknown[]): number[] {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

const dailyUpdateImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const dailyUpdateDocumentExtensions = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv']);
const dailyUpdateImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const dailyUpdateDocumentMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv'
]);

function dailyUpdateIncomingFiles(value: unknown): Express.Multer.File[] {
  const files = Array.isArray(value) ? value : [];
  if (files.length > 10) throw new HttpError(400, 'A daily update can include up to 10 attachments.');
  for (const file of files) {
    const mimeType = String(file.mimetype ?? '').toLowerCase();
    const extension = extensionOf(file.originalname);
    const isImage = dailyUpdateImageMimeTypes.has(mimeType) || dailyUpdateImageExtensions.has(extension);
    const isDocument = dailyUpdateDocumentMimeTypes.has(mimeType) || dailyUpdateDocumentExtensions.has(extension);
    if (!isImage && !isDocument) {
      throw new HttpError(400, 'Daily update attachments must be an image or a PDF, Word, Excel, PowerPoint, text, or CSV document.');
    }
  }
  return files;
}

async function createDailyUpdateAttachments(taskIdValue: number, updateId: number, userId: number, files: Express.Multer.File[]): Promise<LegacyRecord[]> {
  if (!files.length) return [];
  const createdAt = nowIst();
  return Promise.all(files.map(async (file) => {
    const stored = await persistIncomingFile(file, 'task-update-files');
    return createLegacyRecord('task_update_files', {
      task_id: taskIdValue,
      update_id: updateId,
      user_id: userId,
      stored_name: stored.relativePath,
      original_name: file.originalname,
      mime: file.mimetype,
      size_bytes: file.size,
      attachment_type: dailyUpdateFileIsImage(file) ? 'image' : 'document',
      created_at: createdAt
    });
  }));
}

async function archiveDailyUpdateAttachments(updateId: number, attachmentIds?: number[]): Promise<number[]> {
  const requestedIds = attachmentIds === undefined
    ? undefined
    : [...new Set(attachmentIds.filter(isNumber))];
  if (requestedIds && !requestedIds.length) return [];
  const records = await listRawRecords('task_update_files', {
    'raw.update_id': updateId,
    ...(requestedIds ? { legacyId: { $in: requestedIds } } : {})
  }, requestedIds?.length ?? 2_000);
  const recordIds = records.map((record) => record.legacyId).filter(isNumber);
  if (requestedIds && recordIds.length !== requestedIds.length) throw new HttpError(404, 'One or more selected update attachments were not found.');
  return archiveLegacyRecords('task_update_files', recordIds);
}

function dailyUpdateAttachmentKind(record: LegacyRecord): 'image' | 'document' {
  const explicitKind = String(record.raw.attachment_type ?? '').trim().toLowerCase();
  if (explicitKind === 'image' || explicitKind === 'document') return explicitKind;
  return dailyUpdateFileIsImage({
    mimetype: String(record.raw.mime ?? ''),
    originalname: String(record.raw.original_name ?? record.raw.stored_name ?? '')
  }) ? 'image' : 'document';
}

function dailyUpdateFileIsImage(file: Pick<Express.Multer.File, 'mimetype' | 'originalname'>): boolean {
  return dailyUpdateImageMimeTypes.has(String(file.mimetype ?? '').toLowerCase()) || dailyUpdateImageExtensions.has(extensionOf(file.originalname));
}

function dailyUpdateAttachmentStoredPath(record: LegacyRecord): string {
  const storedName = String(record.raw.stored_name ?? record.raw.storage_path ?? '').trim();
  if (!storedName) throw new HttpError(404, 'Update attachment is unavailable.');
  if (storedName.startsWith('modern/')) return storedName;
  return `legacy/storage/task_update_files/${storedName.replace(/^\/+/, '')}`;
}

function dailyUpdateAttachmentContentType(record: LegacyRecord): string {
  return attachmentContentType(record.raw.mime, String(record.raw.original_name ?? record.raw.stored_name ?? ''));
}

function taskFileKind(record: LegacyRecord): 'image' | 'document' {
  return dailyUpdateFileIsImage({
    mimetype: String(record.raw.mime ?? record.raw.mime_type ?? ''),
    originalname: String(record.raw.original_name ?? record.raw.stored_name ?? '')
  }) ? 'image' : 'document';
}

function taskFileStoredPath(record: LegacyRecord): string {
  const storedName = String(record.raw.stored_name ?? record.raw.storage_path ?? '').trim();
  if (!storedName) throw new HttpError(404, 'Task file is unavailable.');
  if (storedName.startsWith('modern/')) return storedName;
  return `legacy/storage/task_files/${storedName.replace(/^\/+/, '')}`;
}

function taskFileContentType(record: LegacyRecord): string {
  return attachmentContentType(record.raw.mime ?? record.raw.mime_type, String(record.raw.original_name ?? record.raw.stored_name ?? ''));
}

function attachmentContentType(value: unknown, fileName: string): string {
  const mimeType = String(value ?? '').trim().toLowerCase();
  if (dailyUpdateImageMimeTypes.has(mimeType) || dailyUpdateDocumentMimeTypes.has(mimeType)) return mimeType;
  switch (extensionOf(fileName)) {
    case '.pdf': return 'application/pdf';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.ppt': return 'application/vnd.ms-powerpoint';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

function extensionOf(value: unknown): string {
  const name = String(value ?? '').trim().toLowerCase();
  const match = name.match(/\.[a-z0-9]{1,10}$/);
  return match?.[0] ?? '';
}

function employeeName(user: LegacyRecord): string {
  return stringValue(user.raw.name)
    || stringValue(user.raw.full_name)
    || stringValue(user.raw.email)
    || `Employee #${user.legacyId}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isActiveUser(status: unknown): boolean {
  const value = stringValue(status).toLowerCase();
  // Older user records did not always retain a status field; those existing
  // account holders remain valid mention targets unless explicitly disabled.
  return !value || ['active', '1', 'true', 'enabled'].includes(value);
}

async function canSeeTask(auth: NonNullable<import('express').Request['auth']>, task: Record<string, unknown>): Promise<boolean> {
  // Employees can work with tasks they own, are assigned to, mentioned in, or
  // tagged in. Keep this before broad manager checks so an employee never
  // gains company-wide visibility through an accidentally broad permission.
  if (isEmployeeRole(auth)) return employeeCanAccessTask(task, auth.legacyId);
  if (can(auth, 'task.manage') || auth.permissions.includes('*') || isAdminOrHrRole(auth)) return true;
  // Department/project managers use the project workspace to supervise every
  // task in a project, even when they are not the individual assignee.
  if (Number(task.project_id) > 0 && (can(auth, 'departments.manage') || can(auth, 'projects.manage'))) return true;
  // Team managers can supervise the work assigned to teams they manage.
  if (Number(task.team_id) > 0 && can(auth, 'teams.manage')) return true;
  if (Number(task.project_id) > 0 && can(auth, 'teams.manage')) {
    const project = await findLegacyRecord('department_projects', Number(task.project_id));
    if (Number(project?.raw.team_id) > 0) return true;
  }
  const userId = auth.legacyId;
  if (await employeeCanAccessTask(task, userId)) return true;
  const teamId = Number(task.team_id);
  if (teamId > 0) {
    const members = await listRawRecords('team_members', { 'raw.team_id': teamId, 'raw.user_id': userId }, 1);
    if (members.length) return true;
  }
  return false;
}

/**
 * Daily updates and task chat are collaborative activity. Notify the person
 * assigned to the task, the person who created/assigned it, and any employees
 * explicitly selected with an @ mention. Values are normalised because older
 * imported task records sometimes store ids as strings.
 */
function taskCollaborationUserIds(task: LegacyRecord, extraIds: number[] = []): number[] {
  const candidateValues: unknown[] = [
    task.raw.assignee_id,
    task.raw.assignee_ids,
    task.raw.assignee_user_id,
    task.raw.assigned_to,
    task.raw.assigned_to_id,
    task.raw.created_by,
    task.raw.created_by_id,
    task.raw.created_by_user_id,
    task.raw.assigned_by,
    task.raw.assigned_by_id,
    task.raw.assigned_by_user_id,
    task.raw.assigner_id,
    task.raw.assigned_user_id,
    task.raw.owner_id,
    task.raw.lead_user_id,
    task.raw.mentioned_user_id,
    task.raw.mentioned_user_ids,
    task.raw.mention_user_ids,
    task.raw.tag_user_id,
    task.raw.tag_user_ids,
    task.raw.tagged_user_id,
    task.raw.tagged_user_ids,
    ...extraIds
  ];
  return [...new Set(candidateValues
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

async function notifyUsers(taskIdValue: number, userIds: number[], actorId: number, type: string, title: string, body: string): Promise<void> {
  const targets = [...new Set(userIds.filter((userId) => isNumber(userId) && userId !== actorId))];
  await Promise.all(targets.map(async (userId) => {
    const notification = await createLegacyRecord('notifications', {
      user_id: userId,
      actor_id: actorId,
      type,
      title,
      body,
      url: `/tasks/${taskIdValue}`,
      entity_type: 'task',
      entity_id: taskIdValue,
      task_id: taskIdValue,
      meta: JSON.stringify({ taskId: taskIdValue }),
      is_read: 0,
      created_at: nowIst()
    });
    emitRealtime('notification:new', { notification: toPublicRecord(notification) }, `user:${userId}`);
  }));
}

function fileUrl(record: LegacyRecord): string | null {
  const storedName = String(record.raw.stored_name ?? record.raw.storage_path ?? '');
  if (!storedName) return null;
  if (storedName.startsWith('modern/')) return legacyAssetUrl(storedName);
  const relative = storedName.replace(/^\/+/, '');
  return legacyAssetUrl(`legacy/storage/task_files/${relative}`);
}

function taskId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid task ID.');
  return parsed;
}

/** Accepts normal JSON arrays as well as the JSON text emitted by FormData. */
function parseArrayInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function numberQuery(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date()).replace(' ', ' ');
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function normalizedDailyUpdateStatus(value: string): 'pending' | 'in_progress' | 'completed' {
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  if (status === 'pending' || status === 'do_later') return 'pending';
  // Review, blocked and the historical working_on values remain work that is
  // currently in progress. This keeps the requested three daily statuses
  // unambiguous without discarding any legacy update record.
  return 'in_progress';
}

function normalizedTaskStatus(value: unknown): 'pending' | 'in_progress' | 'review' | 'completed' | 'blocked' {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'working_on') return 'in_progress';
  if (normalized === 'review' || normalized === 'in_review') return 'review';
  if (normalized === 'blocked') return 'blocked';
  return 'pending';
}

function updateStatusForTaskStatus(status: 'pending' | 'in_progress' | 'review' | 'completed' | 'blocked'): string {
  if (status === 'completed') return 'completed';
  if (status === 'pending') return 'pending';
  return status === 'blocked' ? 'blocked' : 'in_progress';
}

function humanizeTaskStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function uniqueTaskIds(taskIds: number[]): number[] {
  return [...new Set(taskIds)];
}

function emitTaskRecycleChange(
  action: 'recycled' | 'restored',
  taskIds: number[],
  tasks: LegacyRecord[],
  actorId: number
): void {
  const taskIdSet = new Set(taskIds);
  const affectedUserIds = [
    ...new Set([
      actorId,
      ...tasks
        .filter((task) => task.legacyId !== undefined && taskIdSet.has(task.legacyId))
        .flatMap((task) => normalizedUserIds(task.raw.assignee_ids, task.raw.assignee_id))
    ])
  ];

  emitRealtime(`task:${action}`, { taskIds, actorId }, 'tasks');
  emitRealtime('workflow:changed', { userIds: affectedUserIds, date: todayIst() }, 'workforce');
}

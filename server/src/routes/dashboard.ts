import { Router } from 'express';
import { z } from 'zod';
import { type LegacyRecord } from '../db/legacy.js';
import { requireAuth, requireWhatsAppNumber } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { can, canManageLeave, canViewLeave, isEmployeeRole, type AuthContext } from '../services/permissions.js';
import { taskVisibilityScopeWithRelationships } from '../services/taskAccess.js';
import {
  archiveLegacyRecord,
  countLegacyRecords,
  createLegacyRecord,
  findLegacyRecord,
  listRawRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import { toPublicRecordWithRelations, toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const taskStatuses = ['pending', 'in_progress', 'review', 'completed', 'blocked'] as const;
const todoStatusSchema = z.object({ status: z.enum(taskStatuses) });
const workNoteStatuses = ['pending', 'active', 'completed'] as const;
const workNoteStatusSchema = z.enum(workNoteStatuses);
const workNoteCreateSchema = z.object({
  title: z.string().trim().min(1, 'Enter a note title.').max(180, 'Keep the title to 180 characters or fewer.'),
  note: z.string().trim().max(5_000, 'Keep the note to 5,000 characters or fewer.').optional(),
  status: workNoteStatusSchema.optional()
});
const workNoteUpdateSchema = z.object({
  title: z.string().trim().min(1, 'Enter a note title.').max(180, 'Keep the title to 180 characters or fewer.').optional(),
  note: z.string().trim().max(5_000, 'Keep the note to 5,000 characters or fewer.').optional(),
  status: workNoteStatusSchema.optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one change.');

type DashboardAction = {
  id: string;
  label: string;
  description: string;
  to: string;
  icon: string;
  tone: 'indigo' | 'blue' | 'violet' | 'emerald' | 'amber' | 'rose';
};

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireWhatsAppNumber);

dashboardRouter.get('/summary', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');

  const [myTasks, latestNotifications, myWorkNotes] = await Promise.all([
    personalTasks(req.auth),
    listRawRecords('notifications', { 'raw.user_id': req.auth.legacyId }, 8),
    personalWorkNotes(req.auth.legacyId)
  ]);
  const [publicTasks, publicWorkNotes, metrics] = await Promise.all([
    toPublicRecordsWithRelations('tasks', myTasks),
    toPublicRecordsWithRelations('employee_todos', myWorkNotes),
    dashboardMetrics(req.auth, myTasks)
  ]);

  res.json({
    metrics,
    quickActions: quickActionsFor(req.auth),
    myTasks: publicTasks,
    myWorkNotes: publicWorkNotes,
    notifications: latestNotifications.map(brief)
  });
}));

// Personal work notes are deliberately isolated from assigned project tasks.
// The signed-in user is always set server-side and can only access their own
// notes, including when calling the API directly.
dashboardRouter.get('/work-notes', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const records = await personalWorkNotes(req.auth.legacyId);
  res.json({ data: await toPublicRecordsWithRelations('employee_todos', records) });
}));

dashboardRouter.post('/work-notes', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const input = workNoteCreateSchema.parse(req.body);
  const changedAt = nowIst();
  const record = await createLegacyRecord('employee_todos', {
    user_id: req.auth.legacyId,
    title: input.title,
    notes: input.note ?? '',
    status: input.status ?? 'pending',
    created_at: changedAt,
    updated_at: changedAt
  });
  res.status(201).json({ data: await toPublicRecordWithRelations('employee_todos', record) });
}));

dashboardRouter.patch('/work-notes/:noteId', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const noteId = positiveId(req.params.noteId, 'work note');
  const input = workNoteUpdateSchema.parse(req.body);
  await requireOwnedWorkNote(req.auth.legacyId, noteId);

  const changes: Record<string, unknown> = { updated_at: nowIst() };
  if (input.title !== undefined) changes.title = input.title;
  if (input.note !== undefined) changes.notes = input.note;
  if (input.status !== undefined) changes.status = input.status;

  const record = await updateLegacyRecord('employee_todos', noteId, changes);
  if (!record) throw new HttpError(404, 'Work note not found.');
  res.json({ data: await toPublicRecordWithRelations('employee_todos', record) });
}));

dashboardRouter.delete('/work-notes/:noteId', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const noteId = positiveId(req.params.noteId, 'work note');
  await requireOwnedWorkNote(req.auth.legacyId, noteId);
  const deleted = await archiveLegacyRecord('employee_todos', noteId);
  if (!deleted) throw new HttpError(404, 'Work note not found.');
  res.status(204).send();
}));

// The timeline is deliberately user-scoped: an employee can move work they
// own, are assigned to, mentioned in, or tagged in. Managers can also move
// any task they have permission to manage.
dashboardRouter.patch('/todos/:taskId/status', asyncHandler(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Authentication is required.');
  const taskId = positiveId(req.params.taskId, 'task');
  const input = todoStatusSchema.parse(req.body);
  const task = await findLegacyRecord('tasks', taskId);
  if (!task) throw new HttpError(404, 'Task not found.');

  const ownTasks = await personalTasks(req.auth);
  const isOnTimeline = ownTasks.some((record) => record.legacyId === taskId);
  const isManager = can(req.auth, 'task.manage');
  if (!isOnTimeline && !isManager) {
    throw new HttpError(403, 'You do not have permission to update this task.');
  }

  const previousStatus = normalizedTaskStatus(task.raw.status);
  const changedAt = nowIst();
  const record = await updateLegacyRecord('tasks', taskId, {
    status: input.status,
    completed_at: input.status === 'completed' ? changedAt : null,
    updated_at: changedAt
  });
  if (!record) throw new HttpError(404, 'Task not found.');

  // A lightweight update keeps the employee's live-workflow history useful
  // for HR/admin monitoring without altering any historic source records.
  await createLegacyRecord('task_updates', {
    task_id: taskId,
    user_id: req.auth.legacyId,
    update_date: todayIst(),
    update_status: updateStatusFor(input.status),
    update_priority: String(task.raw.priority ?? 'normal'),
    note: `Status changed from ${humanizeStatus(previousStatus)} to ${humanizeStatus(input.status)} from My To-do timeline.`,
    completion_date: input.status === 'completed' ? todayIst() : null,
    created_at: changedAt
  });

  const data = await toPublicRecordWithRelations('tasks', record);
  const affectedUsers = new Set<number>([req.auth.legacyId]);
  for (const value of [task.raw.assignee_id, task.raw.assignee_ids, task.raw.created_by, task.raw.lead_user_id]) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        const userId = numeric(entry);
        if (userId) affectedUsers.add(userId);
      });
      continue;
    }
    const userId = numeric(value);
    if (userId) affectedUsers.add(userId);
  }
  emitRealtime('task:updated', { task: data }, `task:${taskId}`);
  emitRealtime('workflow:changed', { userIds: [...affectedUsers], date: todayIst() }, 'workforce');
  res.json({ data });
}));

async function dashboardMetrics(auth: NonNullable<import('express').Request['auth']>, tasks: LegacyRecord[]) {
  const today = todayIst();
  const myOpen = tasks.filter((task) => normalizedTaskStatus(task.raw.status) !== 'completed').length;
  const dueToday = tasks.filter((task) => String(task.raw.due_date ?? '').slice(0, 10) === today && normalizedTaskStatus(task.raw.status) !== 'completed').length;
  const metrics: Array<{ key: string; label: string; value: number; tone: string }> = [
    { key: 'my-work', label: 'My open work', value: myOpen, tone: 'indigo' },
    { key: 'due-today', label: 'Due today', value: dueToday, tone: 'blue' }
  ];

  const authorisedCounts: Array<Promise<{ key: string; label: string; value: number; tone: string } | null>> = [];
  if (can(auth, 'employees.view') || can(auth, 'employees.manage')) {
    authorisedCounts.push(countLegacyRecords('users', { 'raw.status': 'active' }).then((value) => ({ key: 'people', label: 'Active people', value, tone: 'violet' })));
  }
  if (can(auth, 'billing.view') || can(auth, 'billing.manage')) {
    authorisedCounts.push(countLegacyRecords('invoices', { 'raw.status': { $in: ['draft', 'sent', 'partial', 'overdue'] } }).then((value) => ({ key: 'invoices', label: 'Open invoices', value, tone: 'amber' })));
  }
  if (canViewLeave(auth)) {
    authorisedCounts.push(countLegacyRecords('leave_requests', { 'raw.status': 'pending' }).then((value) => ({ key: 'leave', label: 'Leave requests', value, tone: 'rose' })));
  }
  if (can(auth, 'attendance.view') || can(auth, 'attendance.manage')) {
    authorisedCounts.push(countLegacyRecords('attendance_logs', { 'raw.date': today }).then((value) => ({ key: 'attendance', label: 'Attendance today', value, tone: 'emerald' })));
  }

  return [...metrics, ...(await Promise.all(authorisedCounts)).filter((metric): metric is NonNullable<typeof metric> => Boolean(metric))].slice(0, 4);
}

function quickActionsFor(auth: NonNullable<import('express').Request['auth']>): DashboardAction[] {
  const actions: DashboardAction[] = [
    { id: 'my-tasks', label: 'My tasks', description: 'Open your full task list.', to: '/tasks', icon: 'tasks', tone: 'indigo' }
  ];

  if (isEmployeeRole(auth) || can(auth, 'task.manage')) actions.push({ id: 'new-task', label: 'Create task', description: 'Create and manage your own work.', to: '/tasks?new=1', icon: 'task-plus', tone: 'blue' });
  if (can(auth, 'departments.view') || can(auth, 'departments.manage') || can(auth, 'projects.view') || can(auth, 'projects.manage')) {
    actions.push({ id: 'projects', label: 'Department projects', description: 'Plan work by department.', to: '/data/departments', icon: 'projects', tone: 'violet' });
  }
  if (can(auth, 'teams.view') || can(auth, 'teams.manage')) actions.push({ id: 'teams', label: 'Team hub', description: 'People, team workflow and assignments.', to: '/data/teams', icon: 'teams', tone: 'emerald' });
  if (can(auth, 'attendance.view') || can(auth, 'attendance.manage')) {
    actions.push({ id: 'workforce', label: 'Live workforce', description: 'Monitor attendance and daily activity.', to: '/workforce', icon: 'workforce', tone: 'emerald' });
  }
  if (can(auth, 'billing.manage')) actions.push({ id: 'new-invoice', label: 'Create invoice', description: 'Prepare a branded client invoice.', to: '/invoices?new=1', icon: 'invoice-plus', tone: 'amber' });
  else if (can(auth, 'billing.view')) actions.push({ id: 'invoices', label: 'Invoices', description: 'Review client invoices and payments.', to: '/invoices', icon: 'invoices', tone: 'amber' });
  if (canManageLeave(auth)) actions.push({ id: 'leave', label: 'Review leave', description: 'Review and decide employee leave requests.', to: '/leave?view=manage', icon: 'leave', tone: 'rose' });
  if (can(auth, 'employees.manage')) actions.push({ id: 'people', label: 'Manage people', description: 'Maintain employee information.', to: '/data/users', icon: 'people', tone: 'blue' });
  if (can(auth, 'rbac.manage')) actions.push({ id: 'branding', label: 'Brand settings', description: 'Update title, logo and invoice design.', to: '/settings/branding', icon: 'branding', tone: 'violet' });

  return actions.slice(0, 6);
}

async function personalTasks(auth: AuthContext): Promise<LegacyRecord[]> {
  const userId = auth.legacyId;
  if (isEmployeeRole(auth)) {
    const rows = await listRawRecords('tasks', await taskVisibilityScopeWithRelationships(userId), 20_000);
    return rows.sort((left, right) => taskSort(left) - taskSort(right) || Number(left.legacyId) - Number(right.legacyId));
  }
  const teamMemberships = await listRawRecords('team_members', { 'raw.user_id': userId }, 5_000);
  const teamIds = teamMemberships.flatMap((membership) => {
    const teamId = numeric(membership.raw.team_id);
    return teamId ? [teamId] : [];
  });
  const clauses: Record<string, unknown>[] = [
    { 'raw.assignee_id': userId },
    { 'raw.assignee_ids': userId },
    { 'raw.created_by': userId },
    { 'raw.lead_user_id': userId }
  ];
  if (teamIds.length) clauses.push({ 'raw.team_id': { $in: teamIds } });

  const rows = await listRawRecords('tasks', { $or: clauses }, 20_000);
  return rows.sort((left, right) => taskSort(left) - taskSort(right) || Number(left.legacyId) - Number(right.legacyId));
}

async function personalWorkNotes(userId: number): Promise<LegacyRecord[]> {
  const rows = await listRawRecords('employee_todos', { 'raw.user_id': userId }, 5_000);
  return rows.sort((left, right) => workNoteSort(left) - workNoteSort(right) || right.updatedAt.valueOf() - left.updatedAt.valueOf());
}

async function requireOwnedWorkNote(userId: number, noteId: number): Promise<LegacyRecord> {
  const record = await findLegacyRecord('employee_todos', noteId);
  if (!record) throw new HttpError(404, 'Work note not found.');
  if (numeric(record.raw.user_id) !== userId) {
    throw new HttpError(403, 'You can only manage your own work notes.');
  }
  return record;
}

function taskSort(task: LegacyRecord): number {
  const status = normalizedTaskStatus(task.raw.status);
  if (status === 'blocked') return 0;
  if (status === 'completed') return 3;
  const due = String(task.raw.due_date ?? '').slice(0, 10);
  return due && due < todayIst() ? 1 : 2;
}

function workNoteSort(note: LegacyRecord): number {
  const status = normalizedWorkNoteStatus(note.raw.status);
  if (status === 'active') return 0;
  if (status === 'pending') return 1;
  return 2;
}

function brief(record: LegacyRecord) {
  return {
    legacyId: record.legacyId ?? Number(record.raw.id),
    fields: record.raw,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}

function normalizedTaskStatus(value: unknown): (typeof taskStatuses)[number] {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'review') return 'review';
  if (normalized === 'in_progress' || normalized === 'active') return 'in_progress';
  return 'pending';
}

function normalizedWorkNoteStatus(value: unknown): (typeof workNoteStatuses)[number] {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'active' || normalized === 'in_progress') return 'active';
  return 'pending';
}

function updateStatusFor(status: (typeof taskStatuses)[number]): string {
  if (status === 'completed') return 'complete';
  if (status === 'pending') return 'do_later';
  return status;
}

function humanizeStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function positiveId(value: string | string[] | undefined, label: string): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${label} ID.`);
  return parsed;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date());
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

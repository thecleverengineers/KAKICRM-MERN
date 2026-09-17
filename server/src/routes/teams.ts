import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { type LegacyRecord, type PublicLegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { archiveLegacyRecord, createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecordWithRelations, toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { can } from '../services/permissions.js';
import { notifyTaskAssigneesOnWhatsApp } from '../services/taskAssignmentWhatsApp.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const taskStatuses = ['pending', 'in_progress', 'review', 'completed', 'blocked'] as const;
const taskUserIdsSchema = z.preprocess(parseArrayInput, z.array(z.coerce.number().int().positive()).max(50));

const memberSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  role_in_team: z.string().trim().min(1).max(120).default('Team member')
});

const memberRoleSchema = z.object({
  role_in_team: z.string().trim().min(1).max(120)
});

const teamTaskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional().nullable(),
  status: z.enum(taskStatuses).default('pending'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_date: z.string().max(30).optional().nullable(),
  assignee_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_ids: taskUserIdsSchema.default([]),
  project_id: z.coerce.number().int().positive().optional().nullable()
});

const taskStatusSchema = z.object({ status: z.enum(taskStatuses) });

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

teamsRouter.get('/:teamId', requireTeamRead, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  const team = await getTeam(teamId);
  const [memberRows, projectRows, allTaskRows] = await Promise.all([
    listRawRecords('team_members', { 'raw.team_id': teamId }, 5_000),
    listRawRecords('department_projects', { 'raw.team_id': teamId }, 10_000),
    listRawRecords('tasks', {}, 20_000)
  ]);
  const projectIds = new Set(projectRows.map(recordId));
  const taskRows = allTaskRows.filter((task) => numeric(task.raw.team_id) === teamId || projectIds.has(numeric(task.raw.project_id) ?? -1));
  const tasksByProject = groupByProject(taskRows);
  const [data, members, projects, tasks] = await Promise.all([
    toPublicRecordWithRelations('teams', team),
    toPublicRecordsWithRelations('team_members', memberRows),
    toPublicRecordsWithRelations('department_projects', projectRows),
    toPublicRecordsWithRelations('tasks', taskRows)
  ]);

  res.json({
    data,
    members,
    assignees: buildAssignees(data, members, memberRows),
    projects: projects.map((project, index) => ({
      data: project,
      analytics: projectTaskMetrics(tasksByProject.get(recordId(projectRows[index])) ?? [])
    })),
    tasks,
    analytics: makeAnalytics(projectRows, taskRows, memberRows.length)
  });
}));

teamsRouter.post('/:teamId/members', requireTeamManage, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  await getTeam(teamId);
  const input = memberSchema.parse(req.body);
  const [user, existing] = await Promise.all([
    findLegacyRecord('users', input.user_id),
    listRawRecords('team_members', { 'raw.team_id': teamId, 'raw.user_id': input.user_id }, 1)
  ]);
  if (!user) throw new HttpError(404, 'Employee not found.');
  if (existing.length) throw new HttpError(409, 'This employee is already assigned to the team.');

  const record = await createLegacyRecord('team_members', {
    team_id: teamId,
    user_id: input.user_id,
    role_in_team: input.role_in_team,
    assigned_by: req.auth!.legacyId,
    assigned_at: nowIst(),
    created_at: nowIst(),
    updated_at: nowIst()
  });
  const data = await toPublicRecordWithRelations('team_members', record);
  emitRealtime('team:member-added', { teamId, member: data }, `team:${teamId}`);
  res.status(201).json({ data });
}));

teamsRouter.patch('/:teamId/members/:memberId', requireTeamManage, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  await getTeam(teamId);
  const memberId = idParam(req.params.memberId, 'team member');
  const member = await findLegacyRecord('team_members', memberId);
  if (!member || numeric(member.raw.team_id) !== teamId) throw new HttpError(404, 'Team member not found.');
  const input = memberRoleSchema.parse(req.body);
  const record = await updateLegacyRecord('team_members', memberId, { role_in_team: input.role_in_team, updated_at: nowIst() });
  if (!record) throw new HttpError(404, 'Team member not found.');
  const data = await toPublicRecordWithRelations('team_members', record);
  emitRealtime('team:member-updated', { teamId, member: data }, `team:${teamId}`);
  res.json({ data });
}));

teamsRouter.delete('/:teamId/members/:memberId', requireTeamManage, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  await getTeam(teamId);
  const memberId = idParam(req.params.memberId, 'team member');
  const member = await findLegacyRecord('team_members', memberId);
  if (!member || numeric(member.raw.team_id) !== teamId) throw new HttpError(404, 'Team member not found.');
  const archived = await archiveLegacyRecord('team_members', memberId);
  if (!archived) throw new HttpError(404, 'Team member not found.');
  emitRealtime('team:member-removed', { teamId, memberId }, `team:${teamId}`);
  res.status(204).send();
}));

teamsRouter.post('/:teamId/tasks', requireTeamManage, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  await getTeam(teamId);
  const input = teamTaskSchema.parse(req.body);
  const assigneeIds = uniqueIds([...input.assignee_ids, ...(input.assignee_id ? [input.assignee_id] : [])]);
  for (const assigneeId of assigneeIds) {
    if (!(await isAssignableMember(teamId, assigneeId))) {
      throw new HttpError(400, 'Choose only current members of this team as assignees.');
    }
  }

  let departmentId: number | null = null;
  if (input.project_id) {
    const project = await findLegacyRecord('department_projects', input.project_id);
    if (!project || numeric(project.raw.team_id) !== teamId) throw new HttpError(400, 'The selected project is not assigned to this team.');
    departmentId = numeric(project.raw.department_id);
  }

  const record = await createLegacyRecord('tasks', {
    ...input,
    team_id: teamId,
    department_id: departmentId,
    project_id: input.project_id ?? null,
    assignee_id: assigneeIds[0] ?? null,
    assignee_ids: assigneeIds,
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst(),
    completed_at: input.status === 'completed' ? nowIst() : null
  });
  await notifyTaskAssigneesOnWhatsApp({
    task: record,
    assigneeIds,
    assignedById: req.auth!.legacyId,
    assignedByName: req.auth!.name
  });
  const data = await toPublicRecordWithRelations('tasks', record);
  emitRealtime('task:created', { task: data, teamId }, `team:${teamId}`);
  res.status(201).json({ data });
}));

teamsRouter.patch('/:teamId/tasks/:taskId/status', requireTeamManage, asyncHandler(async (req, res) => {
  const teamId = idParam(req.params.teamId, 'team');
  await getTeam(teamId);
  const taskId = idParam(req.params.taskId, 'task');
  const task = await findLegacyRecord('tasks', taskId);
  if (!task || !(await taskBelongsToTeam(task, teamId))) throw new HttpError(404, 'Team task not found.');
  const input = taskStatusSchema.parse(req.body);
  const record = await updateLegacyRecord('tasks', taskId, {
    status: input.status,
    completed_at: input.status === 'completed' ? nowIst() : null,
    updated_at: nowIst()
  });
  if (!record) throw new HttpError(404, 'Team task not found.');
  const data = await toPublicRecordWithRelations('tasks', record);
  emitRealtime('task:updated', { task: data, teamId }, `team:${teamId}`);
  res.json({ data });
}));

function requireTeamRead(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'teams.view') && !can(req.auth, 'teams.manage')) {
    res.status(403).json({ error: 'You do not have permission to view teams.' });
    return;
  }
  next();
}

function requireTeamManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'teams.manage')) {
    res.status(403).json({ error: 'You do not have permission to manage teams.' });
    return;
  }
  next();
}

async function getTeam(teamId: number): Promise<LegacyRecord> {
  const team = await findLegacyRecord('teams', teamId);
  if (!team) throw new HttpError(404, 'Team not found.');
  return team;
}

async function isAssignableMember(teamId: number, userId: number): Promise<boolean> {
  const [team, membership] = await Promise.all([
    getTeam(teamId),
    listRawRecords('team_members', { 'raw.team_id': teamId, 'raw.user_id': userId }, 1)
  ]);
  return membership.length > 0 || numeric(team.raw.leader_id) === userId;
}

async function taskBelongsToTeam(task: LegacyRecord, teamId: number): Promise<boolean> {
  if (numeric(task.raw.team_id) === teamId) return true;
  const projectId = numeric(task.raw.project_id);
  if (!projectId) return false;
  const project = await findLegacyRecord('department_projects', projectId);
  return Boolean(project && numeric(project.raw.team_id) === teamId);
}

function buildAssignees(team: PublicLegacyRecord, members: PublicLegacyRecord[], memberRows: LegacyRecord[]): Array<{ id: number; name: string }> {
  const output = new Map<number, string>();
  const leaderId = numeric(team.fields.leader_id);
  if (leaderId) output.set(leaderId, String(team.relationLabels?.leader_id ?? `User #${leaderId}`));
  members.forEach((member, index) => {
    const userId = numeric(memberRows[index]?.raw.user_id);
    if (userId) output.set(userId, String(member.relationLabels?.user_id ?? `User #${userId}`));
  });
  return [...output].map(([id, name]) => ({ id, name }));
}

function makeAnalytics(projects: LegacyRecord[], tasks: LegacyRecord[], memberCount: number) {
  const tasksByStatus = { pending: 0, in_progress: 0, review: 0, completed: 0, blocked: 0 };
  let activeProjects = 0;
  let overdueTasks = 0;
  const today = todayIst();
  for (const project of projects) {
    if (projectStatus(project.raw.status) === 'active') activeProjects += 1;
  }
  for (const task of tasks) {
    const status = taskStatus(task.raw.status);
    tasksByStatus[status] += 1;
    const dueDate = String(task.raw.due_date ?? '').slice(0, 10);
    if (dueDate && dueDate < today && status !== 'completed') overdueTasks += 1;
  }
  return {
    memberCount,
    totalProjects: projects.length,
    activeProjects,
    totalTasks: tasks.length,
    tasksByStatus,
    completedTasks: tasksByStatus.completed,
    overdueTasks,
    taskCompletionRate: tasks.length ? Math.round((tasksByStatus.completed / tasks.length) * 100) : 0
  };
}

function projectTaskMetrics(tasks: LegacyRecord[]) {
  const completedTasks = tasks.filter((task) => taskStatus(task.raw.status) === 'completed').length;
  return {
    totalTasks: tasks.length,
    completedTasks,
    taskCompletionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0
  };
}

function groupByProject(tasks: LegacyRecord[]): Map<number, LegacyRecord[]> {
  const groups = new Map<number, LegacyRecord[]>();
  for (const task of tasks) {
    const projectId = numeric(task.raw.project_id);
    if (!projectId) continue;
    const group = groups.get(projectId) ?? [];
    group.push(task);
    groups.set(projectId, group);
  }
  return groups;
}

function projectStatus(value: unknown): 'active' | 'other' {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  return normalized === 'active' || normalized === 'in_progress' || normalized === 'review' ? 'active' : 'other';
}

function taskStatus(value: unknown): (typeof taskStatuses)[number] {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'review') return 'review';
  if (normalized === 'in_progress' || normalized === 'active') return 'in_progress';
  return 'pending';
}

function idParam(value: string | string[] | undefined, label: string): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${label} ID.`);
  return parsed;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function recordId(record: LegacyRecord): number {
  const id = record.legacyId ?? numeric(record.raw.id);
  if (!id) throw new HttpError(500, 'A legacy record has no usable ID.');
  return id;
}

function nowIst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date()).replace(' ', ' ');
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function uniqueIds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function parseArrayInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try { return JSON.parse(trimmed); } catch { return trimmed.split(',').map((item) => item.trim()).filter(Boolean); }
}

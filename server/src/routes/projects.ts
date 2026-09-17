import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { type LegacyRecord, type PublicLegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { toPublicRecordWithRelations, toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { can } from '../services/permissions.js';
import { legacyAssetUrl, persistIncomingFile } from '../services/storage.js';
import { notifyTaskAssigneesOnWhatsApp } from '../services/taskAssignmentWhatsApp.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

const projectStatuses = ['planned', 'active', 'on_hold', 'completed', 'cancelled'] as const;
const taskStatuses = ['pending', 'in_progress', 'review', 'completed', 'blocked'] as const;
const taskUserIdsSchema = z.preprocess(parseArrayInput, z.array(z.coerce.number().int().positive()).max(50));

const projectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  status: z.enum(projectStatuses).default('planned'),
  team_id: z.coerce.number().int().positive().optional().nullable(),
  lead_user_id: z.coerce.number().int().positive().optional().nullable(),
  start_date: z.string().max(30).optional().nullable(),
  end_date: z.string().max(30).optional().nullable(),
  description: z.string().max(20_000).optional().nullable()
});

const projectPatchSchema = projectSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one project change.');
const projectStatusSchema = z.object({ status: z.enum(projectStatuses) });

const projectTaskSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional().nullable(),
  status: z.enum(taskStatuses).default('pending'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_date: z.string().max(30).optional().nullable(),
  assignee_id: z.coerce.number().int().positive().optional().nullable(),
  assignee_ids: taskUserIdsSchema.default([]),
  team_id: z.coerce.number().int().positive().optional().nullable()
});

const taskStatusSchema = z.object({ status: z.enum(taskStatuses) });

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

projectsRouter.get('/departments', requireProjectRead, asyncHandler(async (_req, res) => {
  const [departments, projects, tasks] = await Promise.all([
    listRawRecords('departments', {}, 5_000),
    listRawRecords('department_projects', {}, 10_000),
    listRawRecords('tasks', {}, 20_000)
  ]);
  res.json({ data: await buildDepartmentSummaries(departments, projects, tasks) });
}));

projectsRouter.get('/departments/:departmentId', requireProjectRead, asyncHandler(async (req, res) => {
  const departmentId = idParam(req.params.departmentId, 'department');
  const department = await findLegacyRecord('departments', departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');

  const [projects, allTasks] = await Promise.all([
    listRawRecords('department_projects', { 'raw.department_id': departmentId }, 10_000),
    listRawRecords('tasks', {}, 20_000)
  ]);
  const projectIds = new Set(projects.map(recordId));
  const tasks = allTasks.filter((task) => numeric(task.raw.department_id) === departmentId || projectIds.has(numeric(task.raw.project_id) ?? -1));
  const [summary] = await buildDepartmentSummaries([department], projects, tasks);
  const publicProjects = await toPublicRecordsWithRelations('department_projects', projects);
  const tasksByProject = groupByProject(tasks);

  res.json({
    department: summary,
    projects: publicProjects.map((project, index) => ({
      data: project,
      analytics: makeAnalytics([projects[index]], tasksByProject.get(project.legacyId ?? -1) ?? [])
    })),
    analytics: makeAnalytics(projects, tasks)
  });
}));

projectsRouter.post('/departments/:departmentId/projects', requireProjectManage, asyncHandler(async (req, res) => {
  const departmentId = idParam(req.params.departmentId, 'department');
  const department = await findLegacyRecord('departments', departmentId);
  if (!department) throw new HttpError(404, 'Department not found.');
  const input = projectSchema.parse(req.body);
  const project = await createLegacyRecord('department_projects', {
    ...input,
    department_id: departmentId,
    team_id: input.team_id ?? null,
    lead_user_id: input.lead_user_id ?? null,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    description: input.description ?? null,
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  const data = await toPublicRecordWithRelations('department_projects', project);
  emitRealtime('project:created', { project: data, departmentId }, 'projects');
  res.status(201).json({ data });
}));

projectsRouter.get('/:projectId', requireProjectRead, asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  const project = await getProject(projectId);
  const departmentId = numeric(project.raw.department_id);
  const teamId = numeric(project.raw.team_id);
  const [department, team, taskRows, fileRows] = await Promise.all([
    departmentId ? findLegacyRecord('departments', departmentId) : Promise.resolve(null),
    teamId ? findLegacyRecord('teams', teamId) : Promise.resolve(null),
    listRawRecords('tasks', { 'raw.project_id': projectId }, 10_000),
    listRawRecords('project_files', { 'raw.project_id': projectId }, 10_000)
  ]);
  const memberRows = teamId ? await listRawRecords('team_members', { 'raw.team_id': teamId }, 5_000) : [];
  const [data, publicDepartment, publicTeam, tasks, files, teamMembers, departmentHead, projectHead] = await Promise.all([
    toPublicRecordWithRelations('department_projects', project),
    department ? toPublicRecordWithRelations('departments', department) : Promise.resolve(null),
    team ? toPublicRecordWithRelations('teams', team) : Promise.resolve(null),
    toPublicRecordsWithRelations('tasks', taskRows),
    publicProjectFiles(fileRows),
    toPublicRecordsWithRelations('team_members', memberRows),
    department ? resolveDepartmentHead(department) : Promise.resolve(emptyPerson()),
    resolveUser(numeric(project.raw.lead_user_id))
  ]);

  res.json({
    data,
    department: publicDepartment,
    team: publicTeam,
    teamMembers,
    projectHead,
    departmentHead,
    tasks,
    files,
    analytics: makeAnalytics([project], taskRows)
  });
}));

projectsRouter.patch('/:projectId', requireProjectManage, asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  await getProject(projectId);
  const input = projectPatchSchema.parse(req.body);
  const record = await updateLegacyRecord('department_projects', projectId, { ...input, updated_at: nowIst() });
  if (!record) throw new HttpError(404, 'Project not found.');
  const data = await toPublicRecordWithRelations('department_projects', record);
  emitRealtime('project:updated', { project: data }, 'projects');
  res.json({ data });
}));

projectsRouter.patch('/:projectId/status', requireProjectManage, asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  const input = projectStatusSchema.parse(req.body);
  const record = await updateLegacyRecord('department_projects', projectId, { status: input.status, updated_at: nowIst() });
  if (!record) throw new HttpError(404, 'Project not found.');
  const data = await toPublicRecordWithRelations('department_projects', record);
  emitRealtime('project:updated', { project: data }, 'projects');
  res.json({ data });
}));

projectsRouter.post('/:projectId/tasks', requireProjectManage, asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  const project = await getProject(projectId);
  const input = projectTaskSchema.parse(req.body);
  const assigneeIds = await validAssigneeIds([...input.assignee_ids, ...(input.assignee_id ? [input.assignee_id] : [])]);
  const task = await createLegacyRecord('tasks', {
    ...input,
    department_id: numeric(project.raw.department_id),
    project_id: projectId,
    team_id: input.team_id ?? numeric(project.raw.team_id),
    assignee_id: assigneeIds[0] ?? null,
    assignee_ids: assigneeIds,
    created_by: req.auth!.legacyId,
    created_at: nowIst(),
    updated_at: nowIst(),
    completed_at: input.status === 'completed' ? nowIst() : null
  });
  await notifyTaskAssigneesOnWhatsApp({
    task,
    assigneeIds,
    assignedById: req.auth!.legacyId,
    assignedByName: req.auth!.name
  });
  const data = await toPublicRecordWithRelations('tasks', task);
  emitRealtime('task:created', { task: data, projectId }, 'projects');
  res.status(201).json({ data });
}));

projectsRouter.patch('/:projectId/tasks/:taskId', requireProjectManage, asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  await getProject(projectId);
  const taskId = idParam(req.params.taskId, 'task');
  const task = await findLegacyRecord('tasks', taskId);
  if (!task || numeric(task.raw.project_id) !== projectId) throw new HttpError(404, 'Project task not found.');
  const input = taskStatusSchema.parse(req.body);
  const record = await updateLegacyRecord('tasks', taskId, {
    status: input.status,
    completed_at: input.status === 'completed' ? nowIst() : null,
    updated_at: nowIst()
  });
  if (!record) throw new HttpError(404, 'Project task not found.');
  const data = await toPublicRecordWithRelations('tasks', record);
  emitRealtime('task:updated', { task: data, projectId }, 'projects');
  res.json({ data });
}));

projectsRouter.post('/:projectId/files', requireProjectManage, upload.array('files', 20), asyncHandler(async (req, res) => {
  const projectId = idParam(req.params.projectId, 'project');
  const project = await getProject(projectId);
  const incoming = Array.isArray(req.files) ? req.files : [];
  if (!incoming.length) throw new HttpError(400, 'Select at least one project file.');
  const records = await Promise.all(incoming.map(async (file) => {
    const saved = await persistIncomingFile(file, 'project-files');
    return createLegacyRecord('project_files', {
      project_id: projectId,
      department_id: numeric(project.raw.department_id),
      file_name: saved.relativePath,
      original_name: file.originalname,
      storage_path: saved.relativePath,
      mime_type: file.mimetype,
      file_size: file.size,
      uploaded_by: req.auth!.legacyId,
      created_at: nowIst()
    });
  }));
  const data = await publicProjectFiles(records);
  emitRealtime('project:files', { projectId, files: data }, 'projects');
  res.status(201).json({ data });
}));

function requireProjectRead(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'departments.view') && !can(req.auth, 'departments.manage') && !can(req.auth, 'projects.view') && !can(req.auth, 'projects.manage')) {
    res.status(403).json({ error: 'You do not have permission to view projects.' });
    return;
  }
  next();
}

function requireProjectManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!can(req.auth, 'departments.manage') && !can(req.auth, 'projects.manage')) {
    res.status(403).json({ error: 'You do not have permission to manage projects.' });
    return;
  }
  next();
}

async function getProject(projectId: number): Promise<LegacyRecord> {
  const project = await findLegacyRecord('department_projects', projectId);
  if (!project) throw new HttpError(404, 'Project not found.');
  return project;
}

async function buildDepartmentSummaries(departments: LegacyRecord[], projects: LegacyRecord[], tasks: LegacyRecord[]): Promise<DepartmentSummary[]> {
  const [publicDepartments, headLinks] = await Promise.all([
    toPublicRecordsWithRelations('departments', departments),
    listRawRecords('department_heads', {}, 5_000)
  ]);
  const fallbackHeadByDepartment = new Map<number, number>();
  for (const link of headLinks) {
    const departmentId = numeric(link.raw.department_id);
    const userId = numeric(link.raw.user_id);
    if (departmentId && userId && !fallbackHeadByDepartment.has(departmentId)) fallbackHeadByDepartment.set(departmentId, userId);
  }
  const headIds = departments.map((department) => numeric(department.raw.head_user_id) ?? fallbackHeadByDepartment.get(recordId(department))).filter(isNumber);
  const namesByUserId = await userNames(headIds);
  const projectDepartmentById = new Map(projects.map((project) => [recordId(project), numeric(project.raw.department_id)]));

  return publicDepartments.map((department, index) => {
    const departmentId = recordId(departments[index]);
    const departmentProjects = projects.filter((project) => numeric(project.raw.department_id) === departmentId);
    const projectIds = new Set(departmentProjects.map(recordId));
    const departmentTasks = tasks.filter((task) => numeric(task.raw.department_id) === departmentId || projectIds.has(numeric(task.raw.project_id) ?? -1) || projectDepartmentById.get(numeric(task.raw.project_id) ?? -1) === departmentId);
    const headId = numeric(departments[index].raw.head_user_id) ?? fallbackHeadByDepartment.get(departmentId) ?? null;
    return {
      data: department,
      head: { id: headId, name: department.relationLabels?.head_user_id ?? (headId ? namesByUserId.get(headId) ?? `User #${headId}` : null) },
      analytics: makeAnalytics(departmentProjects, departmentTasks)
    };
  });
}

async function resolveDepartmentHead(department: LegacyRecord): Promise<PersonSummary> {
  let userId = numeric(department.raw.head_user_id);
  if (!userId) {
    const [head] = await listRawRecords('department_heads', { 'raw.department_id': recordId(department) }, 1);
    userId = numeric(head?.raw.user_id);
  }
  return resolveUser(userId);
}

async function resolveUser(userId: number | null): Promise<PersonSummary> {
  if (!userId) return emptyPerson();
  const user = await findLegacyRecord('users', userId);
  return { id: userId, name: user ? String(user.raw.name ?? `User #${userId}`) : `User #${userId}` };
}

async function userNames(userIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(userIds.filter(isNumber))];
  if (!ids.length) return new Map();
  const users = await listRawRecords('users', { legacyId: { $in: ids } }, ids.length + 10);
  return new Map(users.map((user) => [recordId(user), String(user.raw.name ?? `User #${recordId(user)}`)]));
}

async function publicProjectFiles(records: LegacyRecord[]): Promise<Array<PublicLegacyRecord & { url: string | null }>> {
  const publicRecords = await toPublicRecordsWithRelations('project_files', records);
  return publicRecords.map((record, index) => ({ ...record, url: projectFileUrl(records[index]) }));
}

function projectFileUrl(record: LegacyRecord): string | null {
  const stored = String(record.raw.storage_path ?? '').trim();
  if (!stored || stored === '0') return null;
  if (/^https?:\/\//i.test(stored)) return stored;
  return legacyAssetUrl(stored.startsWith('modern/') ? stored : `legacy/storage/project_files/${stored.replace(/^\/+/, '')}`);
}

function groupByProject(tasks: LegacyRecord[]): Map<number, LegacyRecord[]> {
  const grouped = new Map<number, LegacyRecord[]>();
  for (const task of tasks) {
    const projectId = numeric(task.raw.project_id);
    if (!projectId) continue;
    const entries = grouped.get(projectId) ?? [];
    entries.push(task);
    grouped.set(projectId, entries);
  }
  return grouped;
}

function makeAnalytics(projects: LegacyRecord[], tasks: LegacyRecord[]) {
  const projectsByStatus = { planned: 0, active: 0, on_hold: 0, completed: 0, cancelled: 0 };
  const tasksByStatus = { pending: 0, in_progress: 0, review: 0, completed: 0, blocked: 0 };
  let overdueTasks = 0;
  const today = todayIst();

  for (const project of projects) projectsByStatus[projectStatus(project.raw.status)] += 1;
  for (const task of tasks) {
    const status = taskStatus(task.raw.status);
    tasksByStatus[status] += 1;
    const dueDate = String(task.raw.due_date ?? '').slice(0, 10);
    if (dueDate && dueDate < today && status !== 'completed') overdueTasks += 1;
  }

  return {
    totalProjects: projects.length,
    projectsByStatus,
    totalTasks: tasks.length,
    tasksByStatus,
    completedTasks: tasksByStatus.completed,
    overdueTasks,
    taskCompletionRate: tasks.length ? Math.round((tasksByStatus.completed / tasks.length) * 100) : 0
  };
}

function projectStatus(value: unknown): (typeof projectStatuses)[number] {
  const status = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  if (status === 'cancelled' || status === 'canceled' || status === 'closed') return 'cancelled';
  if (status === 'on_hold' || status === 'hold' || status === 'paused') return 'on_hold';
  if (status === 'active' || status === 'in_progress' || status === 'review') return 'active';
  return 'planned';
}

function taskStatus(value: unknown): (typeof taskStatuses)[number] {
  const status = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  if (status === 'blocked') return 'blocked';
  if (status === 'review') return 'review';
  if (status === 'in_progress' || status === 'active') return 'in_progress';
  return 'pending';
}

function idParam(value: string | string[] | undefined, label: string): number {
  const id = numeric(Array.isArray(value) ? value[0] : value);
  if (!id) throw new HttpError(400, `Invalid ${label} ID.`);
  return id;
}

function recordId(record: LegacyRecord): number {
  const id = numeric(record.legacyId ?? record.raw.id);
  if (!id) throw new HttpError(500, 'A legacy record is missing its ID.');
  return id;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function emptyPerson(): PersonSummary {
  return { id: null, name: null };
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

async function validAssigneeIds(ids: number[]): Promise<number[]> {
  const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!unique.length) return [];
  const users = await listRawRecords('users', { legacyId: { $in: unique } }, unique.length);
  const activeIds = new Set(users.filter((user) => !String(user.raw.status ?? '').trim() || ['active', '1', 'true', 'enabled'].includes(String(user.raw.status).trim().toLowerCase())).map((user) => user.legacyId).filter(isNumber));
  if (unique.some((id) => !activeIds.has(id))) throw new HttpError(400, 'One or more selected employees are unavailable.');
  return unique;
}

function parseArrayInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try { return JSON.parse(trimmed); } catch { return trimmed.split(',').map((item) => item.trim()).filter(Boolean); }
}

interface PersonSummary {
  id: number | null;
  name: string | null;
}

interface DepartmentSummary {
  data: PublicLegacyRecord;
  head: PersonSummary;
  analytics: ReturnType<typeof makeAnalytics>;
}

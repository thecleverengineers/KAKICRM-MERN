import { BriefcaseBusiness, CheckSquare, type LucideIcon } from 'lucide-react';
import type { ResourceConfig } from '../config/resources.js';
import type { PublicRecord } from './api.js';

export const PROJECT_KANBAN_COLUMNS = [
  { id: 'planned', label: 'Planned' },
  { id: 'active', label: 'Active' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Closed' }
] as const;

export const TASK_KANBAN_COLUMNS = [
  { id: 'pending', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'completed', label: 'Done' }
] as const;

export type ProjectStatus = (typeof PROJECT_KANBAN_COLUMNS)[number]['id'];
export type TaskStatus = (typeof TASK_KANBAN_COLUMNS)[number]['id'];

export interface ProjectAnalytics {
  totalProjects: number;
  projectsByStatus: Record<ProjectStatus, number>;
  totalTasks: number;
  tasksByStatus: Record<TaskStatus, number>;
  completedTasks: number;
  overdueTasks: number;
  taskCompletionRate: number;
}

export interface PersonSummary {
  id: number | null;
  name: string | null;
}

export interface DepartmentSummary {
  data: PublicRecord;
  head: PersonSummary;
  analytics: ProjectAnalytics;
}

export interface DepartmentProject {
  data: PublicRecord;
  analytics: ProjectAnalytics;
}

export interface DepartmentBoard {
  department: DepartmentSummary;
  projects: DepartmentProject[];
  analytics: ProjectAnalytics;
}

export interface ProjectFile extends PublicRecord {
  url: string | null;
}

export interface ProjectWorkspace {
  data: PublicRecord;
  department: PublicRecord | null;
  team: PublicRecord | null;
  teamMembers: PublicRecord[];
  projectHead: PersonSummary;
  departmentHead: PersonSummary;
  tasks: PublicRecord[];
  files: ProjectFile[];
  analytics: ProjectAnalytics;
}

export const departmentProjectResource: ResourceConfig = {
  id: 'department_projects',
  label: 'Projects',
  singular: 'Project',
  description: 'A department project with its accountable team, project head, dates and note.',
  icon: BriefcaseBusiness as LucideIcon,
  permission: 'departments.manage',
  columns: ['name', 'team_id', 'lead_user_id', 'status', 'start_date', 'end_date'],
  fields: [
    { key: 'name', label: 'Project name', required: true },
    { key: 'team_id', label: 'Assigned team', kind: 'relation', relation: 'teams' },
    { key: 'lead_user_id', label: 'Project head', kind: 'relation', relation: 'users' },
    { key: 'status', label: 'Status', kind: 'select', options: ['planned', 'active', 'on_hold', 'completed', 'cancelled'] },
    { key: 'start_date', label: 'Start date', kind: 'date' },
    { key: 'end_date', label: 'End date', kind: 'date' },
    { key: 'description', label: 'Project note', kind: 'textarea' }
  ]
};

export const projectTaskResource: ResourceConfig = {
  id: 'tasks',
  label: 'Project tasks',
  singular: 'Project task',
  description: 'A task connected to the open project.',
  icon: CheckSquare as LucideIcon,
  permission: 'task.manage',
  columns: ['title', 'status', 'priority', 'assignee_ids', 'due_date'],
  fields: [
    { key: 'title', label: 'Task title', required: true },
    { key: 'description', label: 'Description', kind: 'textarea' },
    { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'in_progress', 'review', 'completed', 'blocked'] },
    { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'normal', 'high', 'urgent'] },
    { key: 'due_date', label: 'Due date', kind: 'date' },
    { key: 'assignee_ids', label: 'Assign to employees', kind: 'multiRelation', relation: 'users' }
  ]
};

export function projectStatus(value: unknown): ProjectStatus {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'closed') return 'cancelled';
  if (normalized === 'on_hold' || normalized === 'hold' || normalized === 'paused') return 'on_hold';
  if (normalized === 'active' || normalized === 'in_progress' || normalized === 'review') return 'active';
  return 'planned';
}

export function taskStatus(value: unknown): TaskStatus {
  const normalized = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'review') return 'review';
  if (normalized === 'in_progress' || normalized === 'active') return 'in_progress';
  return 'pending';
}

export function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

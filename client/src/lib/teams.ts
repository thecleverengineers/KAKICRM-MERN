import { UserPlus, type LucideIcon } from 'lucide-react';
import type { ResourceConfig } from '../config/resources.js';
import type { PublicRecord } from './api.js';
import type { TaskStatus } from './projects.js';

export interface TeamTaskMetrics {
  totalTasks: number;
  completedTasks: number;
  taskCompletionRate: number;
}

export interface TeamWorkspace {
  data: PublicRecord;
  members: PublicRecord[];
  assignees: Array<{ id: number; name: string }>;
  projects: Array<{ data: PublicRecord; analytics: TeamTaskMetrics }>;
  tasks: PublicRecord[];
  analytics: {
    memberCount: number;
    totalProjects: number;
    activeProjects: number;
    totalTasks: number;
    tasksByStatus: Record<TaskStatus, number>;
    completedTasks: number;
    overdueTasks: number;
    taskCompletionRate: number;
  };
}

export const teamMemberResource: ResourceConfig = {
  id: 'team_members',
  label: 'Team members',
  singular: 'Team member',
  description: 'Assign an employee to this team and give them a working role.',
  icon: UserPlus as LucideIcon,
  permission: 'teams.manage',
  columns: ['user_id', 'role_in_team'],
  fields: [
    { key: 'user_id', label: 'Employee', kind: 'relation', relation: 'users', required: true },
    { key: 'role_in_team', label: 'Team role', required: true }
  ]
};

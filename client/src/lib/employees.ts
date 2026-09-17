import type { PublicRecord } from './api.js';
import type { TaskStatus } from './projects.js';

export interface EmployeeProjectMetrics {
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  taskCompletionRate: number;
}

export interface EmployeeAttendanceSummary {
  totalDays: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  totalMinutes: number;
  latestCheckIn: string | null;
}

export interface EmployeeSalarySummary {
  monthlySalary: number | null;
  latestNetPay: number | null;
  currentPeriod: string | null;
  fixedAllowance: number | null;
  fixedDeduction: number | null;
}

export interface EmployeeWorkspace {
  employee: PublicRecord;
  tasks: PublicRecord[];
  teams: Array<{ data: PublicRecord; role: string }>;
  projects: Array<{ data: PublicRecord; assignments: string[]; analytics: EmployeeProjectMetrics }>;
  attendance: {
    allowed: boolean;
    records: PublicRecord[];
    summary: EmployeeAttendanceSummary;
  };
  salary: {
    allowed: boolean;
    profiles: PublicRecord[];
    structures: PublicRecord[];
    payroll: PublicRecord[];
    slips: PublicRecord[];
    summary: EmployeeSalarySummary;
  };
  analytics: {
    totalTasks: number;
    openTasks: number;
    completedTasks: number;
    overdueTasks: number;
    taskCompletionRate: number;
    tasksByStatus: Record<TaskStatus, number>;
    teamCount: number;
    projectCount: number;
  };
  access: {
    canManageEmployee: boolean;
    canManagePassword: boolean;
    canViewAttendance: boolean;
    canViewSalary: boolean;
  };
  passwordConfigured: boolean;
}

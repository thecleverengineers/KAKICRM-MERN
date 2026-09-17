import type { NextFunction, Request, Response } from 'express';
import { can, isAdminOrHrRole, isCeoRole, isEmployeeRole } from '../services/permissions.js';

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication is required.' });
      return;
    }
    if (!can(req.auth, permission)) {
      res.status(403).json({ error: 'You do not have permission to perform this action.' });
      return;
    }
    next();
  };
}

export const collectionPermissions: Record<string, { read?: string; write?: string }> = {
  app_settings: { read: 'rbac.view', write: 'rbac.manage' },
  clara_knowledge: { read: 'dashboard.view', write: 'rbac.manage' },
  clara_training_examples: { read: 'dashboard.view', write: 'rbac.manage' },
  clara_feedback: { read: 'rbac.view', write: 'rbac.manage' },
  clara_audit_logs: { read: 'rbac.view', write: 'rbac.manage' },
  clara_settings: { read: 'rbac.view', write: 'rbac.manage' },
  ceo_approvals: { read: 'ceo.approvals.view', write: 'ceo.approvals.manage' },
  ceo_approval_rules: { read: 'ceo.settings.view', write: 'ceo.settings.manage' },
  ceo_audit_logs: { read: 'ceo.audit.view', write: 'ceo.audit.manage' },
  ceo_delegations: { read: 'ceo.delegation.view', write: 'ceo.delegation.manage' },
  ceo_notes: { read: 'ceo.workspace', write: 'ceo.workspace' },
  ceo_goals: { read: 'ceo.workspace', write: 'ceo.workspace' },
  ceo_risks: { read: 'ceo.workspace', write: 'ceo.workspace' },
  ceo_forecasts: { read: 'ceo.workspace', write: 'ceo.workspace' },
  ceo_announcements: { read: 'ceo.workspace', write: 'ceo.workspace' },
  google_integrations: { read: 'meetings.manageIntegrations', write: 'meetings.manageIntegrations' },
  meeting_oauth_states: { read: 'meetings.manageIntegrations', write: 'meetings.manageIntegrations' },
  meeting_attendance_sync_events: { read: 'meetings.viewAttendance', write: 'meetings.viewAttendance' },
  meeting_webhook_events: { read: 'meetings.viewAttendance', write: 'meetings.viewAttendance' },
  meeting_notification_events: { read: 'meetings.view', write: 'meetings.manage' },
  calendar_events: { read: 'calendar.view', write: 'calendar.manage' },
  users: { read: 'employees.view', write: 'employees.manage' },
  employees: { read: 'employees.view', write: 'employees.manage' },
  departments: { read: 'departments.view', write: 'departments.manage' },
  department_heads: { read: 'departments.view', write: 'departments.manage' },
  department_projects: { read: 'departments.view', write: 'departments.manage' },
  teams: { read: 'teams.view', write: 'teams.manage' },
  team_members: { read: 'teams.view', write: 'teams.manage' },
  team_messages: { read: 'teams.view', write: 'teams.manage' },
  tasks: { read: 'task.view', write: 'task.manage' },
  task_updates: { read: 'task.view', write: 'task.update' },
  task_chats: { read: 'task.view', write: 'task.update' },
  task_chat: { read: 'task.view', write: 'task.update' },
  projects: { read: 'projects.view', write: 'projects.manage' },
  expenses: { read: 'expenses.view', write: 'expenses.manage' },
  budgets: { read: 'expenses.view', write: 'expenses.manage' },
  leads: { read: 'leads.view', write: 'leads.manage' },
  quotations: { read: 'quotations.view', write: 'quotations.manage' },
  meetings: { read: 'meetings.view', write: 'meetings.manage' },
  reports: { read: 'reports.view', write: 'reports.manage' },
  clients: { read: 'clients.view', write: 'clients.manage' },
  invoices: { read: 'billing.view', write: 'billing.manage' },
  billing_profiles: { read: 'billing.view', write: 'billing.manage' },
  maintenance_contracts: { read: 'billing.view', write: 'billing.manage' },
  client_maintenance_contracts: { read: 'billing.view', write: 'billing.manage' },
  payments: { read: 'billing.view', write: 'billing.manage' },
  attendance_logs: { read: 'attendance.view', write: 'attendance.manage' },
  attendance_holidays: { read: 'attendance.view', write: 'attendance.manage' },
  attendance_shifts: { read: 'attendance.view', write: 'attendance.manage' },
  attendance_breaks: { read: 'attendance.view', write: 'attendance.manage' },
  attendance_overtime: { read: 'attendance.view', write: 'attendance.manage' },
  leave_requests: { read: 'leave.view', write: 'leave.manage' },
  payroll_items: { read: 'payroll.view', write: 'payroll.manage' },
  payroll_runs: { read: 'payroll.view', write: 'payroll.manage' },
  payroll_monthly: { read: 'payroll.view', write: 'payroll.manage' },
  salary_profiles: { read: 'salary.view', write: 'salary.manage' },
  salary_structures: { read: 'salary.view', write: 'salary.manage' },
  recruitment_positions: { read: 'recruitments.view', write: 'recruitments.manage' },
  recruitment_applicants: { read: 'recruitments.applicants.view', write: 'recruitments.applicants.manage' },
  drive_items: { read: 'drive.view', write: 'drive.manage' },
  roles: { read: 'rbac.view', write: 'rbac.manage' },
  permissions: { read: 'rbac.view', write: 'rbac.manage' },
  role_permissions: { read: 'rbac.view', write: 'rbac.manage' }
};

export function hasCollectionAccess(req: Request, collection: string, mode: 'read' | 'write'): boolean {
  if (!req.auth) return false;
  if (req.auth.permissions.includes('*')) return true;
  // The CEO has company-wide read access, including imported collections that
  // do not have a dedicated navigation entry. Writes still require an
  // explicit collection permission or one of the audited CEO endpoints.
  if (mode === 'read' && isCeoRole(req.auth)) return true;
  // Meetings are a shared operational workflow: HR and administrators can
  // manage them even when an older role-permission import predates meetings.
  if (collection === 'meetings' && isAdminOrHrRole(req.auth)) return true;
  if (collection === 'meetings') {
    return mode === 'read'
      ? can(req.auth, 'meetings.view') || can(req.auth, 'meetings.viewAttendance') || isEmployeeRole(req.auth)
      : can(req.auth, 'meetings.manage') || can(req.auth, 'meetings.create') || can(req.auth, 'meetings.update') || can(req.auth, 'meetings.cancel');
  }
  const permission = collectionPermissions[collection]?.[mode];
  return permission ? can(req.auth, permission) : false;
}

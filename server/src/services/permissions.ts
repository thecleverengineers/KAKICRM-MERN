import { getLegacyModel, type LegacyRecord } from '../db/legacy.js';

export interface AuthContext {
  recordId: string;
  legacyId: number;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  hasWhatsAppNumber: boolean;
}

/**
 * CEO access is intentionally explicit instead of using the administrator
 * wildcard. This keeps the audit/approval boundary visible and makes it
 * possible to add or remove a CEO capability without accidentally granting
 * access to authentication internals.
 */
export const CEO_PERMISSION_SET = [
  'ceo.dashboard', 'ceo.approvals.view', 'ceo.approvals.manage',
  'ceo.settings.view', 'ceo.settings.manage', 'ceo.workspace',
  'ceo.reports', 'ceo.audit.view', 'ceo.delegation.view', 'ceo.delegation.manage',
  'dashboard.view', 'task.view', 'task.update', 'task.manage',
  'projects.view', 'projects.manage', 'departments.view', 'departments.manage',
  'teams.view', 'teams.manage', 'employees.view', 'employees.manage',
  'clients.view', 'clients.manage', 'billing.view', 'billing.manage',
  'attendance.view', 'attendance.manage', 'leave.view', 'leave.manage',
  'payroll.view', 'payroll.manage', 'salary.view', 'salary.manage',
  'recruitments.view', 'recruitments.manage', 'recruitments.applicants.view',
  'recruitments.applicants.manage', 'drive.view', 'drive.manage',
  'remotework.view', 'messenger.view', 'notifications.view', 'reports.view',
  'expenses.view', 'expenses.manage', 'meetings.view', 'meetings.manage',
  'meetings.create', 'meetings.update', 'meetings.cancel', 'meetings.delete',
  'meetings.viewAttendance', 'meetings.manageIntegrations', 'meetings.viewArtifacts',
  'leads.view', 'leads.manage', 'quotations.view', 'quotations.manage',
  'payments.view', 'payments.manage',
  'calendar.view', 'calendar.manage',
] as const;

export async function buildAuthContext(user: LegacyRecord): Promise<AuthContext> {
  const raw = user.raw;
  const role = String(raw.role ?? 'employee').toLowerCase();
  const permissions = await permissionsForUser(user);

  return {
    recordId: String(user._id),
    legacyId: user.legacyId ?? Number(raw.id),
    name: String(raw.name ?? 'User'),
    email: String(raw.email ?? ''),
    role,
    permissions,
    hasWhatsAppNumber: hasSavedWhatsAppNumber(raw)
  };
}

export async function permissionsForUser(user: LegacyRecord): Promise<string[]> {
  const role = String(user.raw.role ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (role === 'admin') return ['*'];
  if (isCeoRole({ role })) return [...CEO_PERMISSION_SET];

  const roleId = await resolveRoleId(user);
  if (!roleId) return [];

  const [links, permissions] = await Promise.all([
    getLegacyModel('role_permissions').find({ 'raw.role_id': roleId, archivedAt: { $exists: false } }).lean<LegacyRecord[]>(),
    getLegacyModel('permissions').find({ archivedAt: { $exists: false } }).lean<LegacyRecord[]>()
  ]);

  const permissionIds = new Set(links.map((link) => Number(link.raw.permission_id)));
  return permissions
    .filter((permission) => permissionIds.has(Number(permission.legacyId ?? permission.raw.id)))
    .map((permission) => String(permission.raw.code))
    .filter(Boolean);
}

export function can(context: AuthContext, permission?: string): boolean {
  if (!permission) return true;
  return context.permissions.includes('*') || context.permissions.includes(permission);
}

/**
 * Employee accounts work only with tasks explicitly assigned to them. This is
 * role-based rather than permission-based so an accidentally broad permission
 * assignment cannot expose another employee's task list.
 */
export function isEmployeeRole(context: Pick<AuthContext, 'role'>): boolean {
  return context.role.trim().toLowerCase() === 'employee';
}

export function isCeoRole(context: Pick<AuthContext, 'role'>): boolean {
  const role = context.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['ceo', 'chief_executive_officer', 'chief_executive'].includes(role);
}

/** Roles that can carry out day-to-day people operations even when a legacy
 * permission link has not been migrated for the HR account yet. */
export function isAdminOrHrRole(context: Pick<AuthContext, 'role'>): boolean {
  const role = context.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['admin', 'administrator', 'hr', 'hr_manager', 'human_resources', 'human_resource'].includes(role);
}

export function canManageLeave(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || isCeoRole(context) || can(context, 'leave.manage');
}

export function canViewLeave(context: AuthContext): boolean {
  return canManageLeave(context) || can(context, 'leave.view');
}

export function canManageInvoiceSettlement(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || can(context, 'billing.manage');
}

export function canViewInvoices(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || can(context, 'billing.view') || can(context, 'billing.manage');
}

export function canManagePayroll(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || can(context, 'payroll.manage') || can(context, 'salary.manage') || can(context, 'employees.manage');
}

export function canViewPayroll(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || can(context, 'payroll.view') || can(context, 'salary.view') || can(context, 'employees.manage');
}

export function canManageAttendance(context: AuthContext): boolean {
  return isAdminOrHrRole(context) || can(context, 'attendance.manage') || can(context, 'employees.manage');
}

/**
 * Supports the common imported field names while new updates are stored in
 * `whatsapp_number`. A number must still look like a real phone number before
 * it unlocks the workspace.
 */
export function hasSavedWhatsAppNumber(fields: Record<string, unknown>): boolean {
  return Boolean(readSavedWhatsAppNumber(fields));
}

/** Returns the first valid WhatsApp number stored on a user profile. */
export function readSavedWhatsAppNumber(fields: Record<string, unknown>): string | null {
  for (const field of ['whatsapp_number', 'whatsapp', 'whatsapp_no', 'whatsapp_phone']) {
    const compact = String(fields[field] ?? '').trim().replace(/[()\s.-]/g, '');
    if (/^\+?[1-9]\d{6,14}$/.test(compact)) return compact;
  }
  return null;
}

export async function resolveUserByRecordId(recordId: string): Promise<LegacyRecord | null> {
  return getLegacyModel('users').findOne({ _id: recordId, archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
}

async function resolveRoleId(user: LegacyRecord): Promise<number | null> {
  const directRoleId = numeric(user.raw.role_id);
  if (directRoleId) return directRoleId;

  const roleSlug = String(user.raw.role ?? '').toLowerCase();
  if (!roleSlug) return null;

  const role = await getLegacyModel('roles').findOne({ 'raw.slug': roleSlug, archivedAt: { $exists: false } }).lean<LegacyRecord | null>();
  return role?.legacyId ?? numeric(role?.raw.id);
}

function numeric(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

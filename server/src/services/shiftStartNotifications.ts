import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { emitRealtime } from '../realtime.js';
import { createLegacyRecord, listRawRecords } from './legacyRepository.js';

interface ShiftStartNotificationInput {
  employeeId: number;
  employeeName: string;
  shiftId: number;
  workDate: string;
  startedAt: string;
}

interface ShiftStartRecipient {
  userId: number;
}

const workforcePermissionCodes = new Set(['attendance.view', 'attendance.manage']);

/**
 * Persist and push a live attendance alert to every active Administrator and
 * HR user. Custom roles with workforce visibility/management permissions are
 * included too, so role renames do not silently stop attendance monitoring.
 */
export async function notifyShiftStarted(input: ShiftStartNotificationInput): Promise<void> {
  const recipients = await findShiftStartRecipients();
  if (!recipients.length) return;

  const employeeName = input.employeeName.trim() || 'An employee';
  const title = 'Shift started';
  const body = `${employeeName} started their shift at ${formatIstTime(input.startedAt)} IST.`;
  const meta = JSON.stringify({
    event: 'attendance.shift_started',
    employee_id: input.employeeId,
    employee_name: employeeName,
    shift_id: input.shiftId,
    work_date: input.workDate,
    started_at: input.startedAt
  });

  const results = await Promise.allSettled(recipients.map(async ({ userId }) => {
    const notification = await createLegacyRecord('notifications', {
      user_id: userId,
      actor_id: input.employeeId,
      type: 'attendance.shift_started',
      title,
      body,
      url: '/workforce',
      entity_type: 'attendance_shift',
      entity_id: input.shiftId,
      employee_id: input.employeeId,
      employee_name: employeeName,
      meta,
      is_read: 0,
      created_at: input.startedAt
    });

    emitRealtime('notification:new', {
      notification: toPublicRecord(notification),
      alert: {
        type: 'attendance.shift_started',
        employeeId: input.employeeId,
        employeeName,
        shiftId: input.shiftId,
        workDate: input.workDate,
        startedAt: input.startedAt
      }
    }, `user:${userId}`);
  }));

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    console.error(`[KAKI CRM] ${failures.length} shift-start notification(s) could not be delivered.`, failures);
  }
}

async function findShiftStartRecipients(): Promise<ShiftStartRecipient[]> {
  const [users, roles, permissions, rolePermissions] = await Promise.all([
    listRawRecords('users', {}, 2_000),
    listRawRecords('roles', {}, 1_000),
    listRawRecords('permissions', {}, 3_000),
    listRawRecords('role_permissions', {}, 10_000)
  ]);

  const roleById = new Map<number, LegacyRecord>();
  const roleIdByLabel = new Map<string, number>();
  for (const role of roles) {
    const id = positiveInteger(role.legacyId ?? role.raw.id);
    if (!id) continue;
    roleById.set(id, role);
    for (const value of [role.raw.slug, role.raw.name, role.raw.title]) {
      const label = normalizedRole(value);
      if (label) roleIdByLabel.set(label, id);
    }
  }

  const workforcePermissionIds = new Set(
    permissions
      .filter((permission) => workforcePermissionCodes.has(String(permission.raw.code ?? '').trim().toLowerCase()))
      .map((permission) => positiveInteger(permission.legacyId ?? permission.raw.id))
      .filter((id): id is number => id !== null)
  );
  const workforceRoleIds = new Set(
    rolePermissions
      .filter((link) => workforcePermissionIds.has(positiveInteger(link.raw.permission_id) ?? -1))
      .map((link) => positiveInteger(link.raw.role_id))
      .filter((id): id is number => id !== null)
  );

  const recipients = new Map<number, ShiftStartRecipient>();
  for (const user of users) {
    if (String(user.raw.status ?? 'active').trim().toLowerCase() !== 'active') continue;
    const userId = positiveInteger(user.legacyId ?? user.raw.id);
    if (!userId) continue;

    const userRole = normalizedRole(user.raw.role);
    const roleId = positiveInteger(user.raw.role_id)
      ?? positiveInteger(user.raw.role)
      ?? roleIdByLabel.get(userRole);
    const linkedRole = roleId ? roleById.get(roleId) : undefined;
    const linkedRoleLabels = [linkedRole?.raw.slug, linkedRole?.raw.name, linkedRole?.raw.title];
    const isNamedAdminOrHr = isAdminOrHr(userRole) || linkedRoleLabels.some((value) => isAdminOrHr(normalizedRole(value)));

    if (isNamedAdminOrHr || Boolean(roleId && workforceRoleIds.has(roleId))) {
      recipients.set(userId, { userId });
    }
  }

  return [...recipients.values()];
}

function isAdminOrHr(role: string): boolean {
  return role === 'admin'
    || role === 'administrator'
    || role.startsWith('admin ')
    || role === 'hr'
    || role.startsWith('hr ')
    || role.includes('human resource');
}

function normalizedRole(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatIstTime(value: string): string {
  const match = value.match(/(?:\s|T)(\d{2}):(\d{2})/);
  if (!match) return 'now';
  const hour = Number(match[1]);
  if (!Number.isFinite(hour)) return `${match[1]}:${match[2]}`;
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${match[2]} ${suffix}`;
}

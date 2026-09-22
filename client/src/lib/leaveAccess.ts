const leaveManagerRoles = new Set([
  'admin', 'administrator', 'hr', 'hr_manager', 'human_resources', 'human_resource',
  'ceo', 'chief_executive_officer', 'chief_executive'
]);

export function canManageLeaveAccess(role?: string, permissions: string[] = []): boolean {
  const normalizedRole = String(role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return permissions.includes('*') || permissions.includes('leave.manage') || leaveManagerRoles.has(normalizedRole);
}

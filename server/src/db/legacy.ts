import crypto from 'node:crypto';
import mongoose, { type Model } from 'mongoose';

export const LEGACY_COLLECTIONS = [
  'activity_logs',
  'announcements',
  'announcement_reads',
  'app_settings',
  'clara_knowledge',
  'clara_training_examples',
  'clara_feedback',
  'clara_audit_logs',
  'clara_settings',
  'ceo_approvals',
  'ceo_approval_rules',
  'ceo_audit_logs',
  'ceo_delegations',
  'ceo_notes',
  'ceo_goals',
  'ceo_risks',
  'ceo_forecasts',
  'ceo_announcements',
  'google_integrations',
  'meeting_oauth_states',
  'meeting_attendance_sync_events',
  'meeting_webhook_events',
  'meeting_notification_events',
  'calendar_events',
  'attendance_breaks',
  'attendance_holidays',
  'attendance_logs',
  'attendance_overtime',
  'attendance_shifts',
  'billing_profiles',
  'clients',
  'client_contacts',
  'client_invoices',
  'client_invoice_items',
  'client_maintenance_contracts',
  'client_projects',
  'daily_checkins',
  'daily_reports',
  'departments',
  'department_heads',
  'department_projects',
  'drive_items',
  'expenses',
  'employees',
  'employee_assets',
  'employee_job_history',
  'employee_kyc_documents',
  'employee_todos',
  'files',
  'folders',
  'hr_candidates',
  'hr_candidate_docs',
  'invoices',
  'invoice_items_new',
  'leave_requests',
  'leave_request_files',
  'leads',
  'maintenance_contracts',
  'meetings',
  'messenger_attachments',
  'messenger_conversations',
  'messenger_messages',
  'messenger_message_reactions',
  'messenger_participants',
  'notifications',
  'notification_import_state',
  'payments',
  'payroll_auto_logs',
  'payroll_items',
  'payroll_monthly',
  'payroll_runs',
  'permissions',
  'project_files',
  'quotations',
  'recruitment_applicants',
  'recruitment_applicant_logs',
  'recruitment_files',
  'recruitment_positions',
  'remote_shifts',
  'reports',
  'roles',
  'role_permissions',
  'salary_profiles',
  'salary_slips',
  'salary_structures',
  'tasks',
  'task_chat',
  'task_chats',
  'task_chat_attachments',
  'task_chat_mentions',
  'task_chat_polls',
  'task_chat_poll_options',
  'task_chat_poll_votes',
  'task_files',
  'task_followers',
  'task_notifications',
  'task_time_logs',
  'task_updates',
  'task_update_files',
  'task_update_people',
  'task_update_progress',
  'task_update_tags',
  'task_work_updates',
  'teams',
  'team_members',
  'team_messages',
  'budgets',
  'timesheets',
  'time_logs',
  'users',
  'user_work_sessions',
  'weekly_reports'
] as const;

export type LegacyCollection = (typeof LEGACY_COLLECTIONS)[number];

export interface LegacyRecord {
  _id: mongoose.Types.ObjectId;
  legacyId?: number;
  legacyCompositeKey?: string;
  legacySourceChecksum?: string;
  legacyImportedAt?: Date;
  raw: Record<string, unknown>;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const collectionSet = new Set<string>(LEGACY_COLLECTIONS);

const recordSchema = new mongoose.Schema<LegacyRecord>(
  {
    legacyId: { type: Number },
    legacyCompositeKey: { type: String },
    legacySourceChecksum: { type: String },
    legacyImportedAt: { type: Date },
    raw: { type: mongoose.Schema.Types.Mixed, required: true },
    archivedAt: { type: Date }
  },
  {
    timestamps: true,
    minimize: false,
    strict: true,
    id: false,
    versionKey: false
  }
);

recordSchema.index({ legacyId: 1 }, { unique: true, sparse: true });
recordSchema.index({ legacyCompositeKey: 1 }, { unique: true, sparse: true });
recordSchema.index({ legacySourceChecksum: 1, archivedAt: 1 });
recordSchema.index({ archivedAt: 1, updatedAt: -1 });
// Operational indexes used by meetings, attendance sync and the CEO summary.
// They are defined on the shared legacy schema, so MongoDB creates them only
// for collections where the corresponding raw fields are present.
recordSchema.index({ 'raw.organizer_id': 1, 'raw.scheduled_start': 1, archivedAt: 1 });
recordSchema.index({ 'raw.status': 1, 'raw.scheduled_start': 1, archivedAt: 1 });
recordSchema.index({ 'raw.google_calendar_event_id': 1 }, { sparse: true });
recordSchema.index({ 'raw.google_conference_record_name': 1 }, { sparse: true });
recordSchema.index({ 'raw.organizer_id': 1, 'raw.idempotency_key': 1 }, { sparse: true });
recordSchema.index({ 'raw.invitees.crm_user': 1 }, { sparse: true });
recordSchema.index({ 'raw.user_id': 1, 'raw.created_at': -1, archivedAt: 1 });

export function assertLegacyCollection(value: string): asserts value is LegacyCollection {
  if (!collectionSet.has(value)) {
    throw new Error(`Unknown legacy collection: ${value}`);
  }
}

export function getLegacyModel(collection: LegacyCollection): Model<LegacyRecord> {
  const modelName = `Legacy_${collection}`;
  return (mongoose.models[modelName] as Model<LegacyRecord> | undefined)
    ?? mongoose.model<LegacyRecord>(modelName, recordSchema, collection);
}

export function makeCompositeKey(collection: LegacyCollection, raw: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(`${collection}:${stableStringify(raw)}`)
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

const SENSITIVE_FIELD_NAMES = new Set([
  'password',
  'password_hash',
  'password_reset_token',
  'reset_token',
  'access_token',
  'refresh_token',
  'api_key',
  'secret'
]);

export interface PublicLegacyRecord {
  id: string;
  legacyId: number | null;
  fields: Record<string, unknown>;
  relationLabels?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toPublicRecord(record: LegacyRecord, options: { revealSensitive?: boolean } | number = {}): PublicLegacyRecord {
  const revealSensitive = typeof options === 'object' && options.revealSensitive === true;
  const fields = Object.fromEntries(
    Object.entries(record.raw ?? {}).filter(([key]) => revealSensitive || !isSensitiveFieldName(key))
  );

  return {
    id: String(record._id),
    legacyId: record.legacyId ?? numericId(fields.id),
    fields,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    archivedAt: record.archivedAt?.toISOString() ?? null
  };
}

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (SENSITIVE_FIELD_NAMES.has(normalized)) return true;
  // Configuration records can safely retain encrypted values in MongoDB, but
  // neither encrypted credentials nor their authentication material should be
  // returned through generic record APIs.
  return /(^|_)(api[_-]?key|secret|token|password|ciphertext|encryption|auth(?:orization)?)(_|$)/.test(normalized);
}

function numericId(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

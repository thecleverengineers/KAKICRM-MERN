import { getLegacyModel, toPublicRecord, type LegacyCollection, type LegacyRecord, type PublicLegacyRecord } from '../db/legacy.js';

interface RelationDefinition {
  target: RelationLookupCollection;
}

const USER = { target: 'users' } as const;
const DEPARTMENT = { target: 'departments' } as const;
const TEAM = { target: 'teams' } as const;
const PROJECT = { target: 'department_projects' } as const;
const DRIVE_ITEM = { target: 'drive_items' } as const;
const FOLDER = { target: 'folders' } as const;
const POSITION = { target: 'recruitment_positions' } as const;
const CLIENT = { target: 'clients' } as const;

export const RELATION_LOOKUP_COLLECTIONS = [
  'users',
  'departments',
  'teams',
  'department_projects',
  'drive_items',
  'folders',
  'recruitment_positions',
  'clients'
] as const satisfies readonly LegacyCollection[];

export type RelationLookupCollection = (typeof RELATION_LOOKUP_COLLECTIONS)[number];

const labelFields: Record<RelationLookupCollection, readonly string[]> = {
  users: ['name'],
  departments: ['name'],
  teams: ['name'],
  department_projects: ['name'],
  drive_items: ['name'],
  folders: ['name'],
  recruitment_positions: ['title', 'name'],
  clients: ['name']
};

const relations: Partial<Record<LegacyCollection, Record<string, RelationDefinition>>> = {
  departments: { head_user_id: USER },
  department_heads: { department_id: DEPARTMENT, user_id: USER },
  department_projects: { department_id: DEPARTMENT, team_id: TEAM, lead_user_id: USER },
  teams: { leader_id: USER },
  team_members: { team_id: TEAM, user_id: USER },
  team_messages: { team_id: TEAM },
  tasks: { department_id: DEPARTMENT, team_id: TEAM, project_id: PROJECT, assignee_id: USER, assignee_ids: USER },
  leave_requests: { user_id: USER, reviewed_by: USER },
  task_chat: { user_id: USER },
  task_chats: { user_id: USER },
  task_followers: { user_id: USER },
  task_time_logs: { user_id: USER },
  project_files: { department_id: DEPARTMENT, project_id: PROJECT, uploaded_by: USER },
  hr_candidates: { department_id: DEPARTMENT },
  recruitment_positions: { department_id: DEPARTMENT },
  recruitment_applicants: { position_id: POSITION },
  recruitment_applicant_logs: { position_id: POSITION },
  recruitment_files: { position_id: POSITION },
  drive_items: { parent_id: DRIVE_ITEM },
  folders: { parent_id: FOLDER, team_id: TEAM },
  files: { team_id: TEAM },
  client_contacts: { client_id: CLIENT },
  client_invoices: { client_id: CLIENT },
  client_maintenance_contracts: { client_id: CLIENT },
  client_projects: { client_id: CLIENT },
  invoices: { client_id: CLIENT },
  maintenance_contracts: { client_id: CLIENT },
  payments: { client_id: CLIENT },
  meetings: { organizer_id: USER },
  ceo_delegations: { delegate_user_id: USER },
  ceo_approvals: { requested_by: USER, decided_by: USER }
};

export interface RelationOption {
  id: number;
  label: string;
}

export async function toPublicRecordWithRelations(collection: LegacyCollection, record: LegacyRecord): Promise<PublicLegacyRecord> {
  const [result] = await toPublicRecordsWithRelations(collection, [record]);
  return result;
}

export async function toPublicRecordsWithRelations(collection: LegacyCollection, records: LegacyRecord[]): Promise<PublicLegacyRecord[]> {
  const publicRecords = records.map((record) => toPublicRecord(record));
  const definitions = relations[collection];
  if (!records.length || !definitions) return publicRecords;

  const idsByTarget = new Map<RelationLookupCollection, Set<number>>();
  for (const record of records) {
    for (const [field, definition] of Object.entries(definitions)) {
      const idsForField = relationIds(record.raw[field]);
      if (!idsForField.length) continue;
      const ids = idsByTarget.get(definition.target) ?? new Set<number>();
      idsForField.forEach((id) => ids.add(id));
      idsByTarget.set(definition.target, ids);
    }
  }

  const loaded = await Promise.all([...idsByTarget.entries()].map(async ([target, ids]) => [
    target,
    await loadLabels(target, [...ids])
  ] as const));
  const labelsByTarget = new Map<RelationLookupCollection, Map<number, string>>(loaded);

  return records.map((record, index) => {
    const relationLabels: Record<string, string> = {};
    for (const [field, definition] of Object.entries(definitions)) {
      const labels = relationIds(record.raw[field])
        .map((id) => labelsByTarget.get(definition.target)?.get(id))
        .filter((label): label is string => Boolean(label));
      if (labels.length) relationLabels[field] = labels.join(', ');
    }
    return Object.keys(relationLabels).length
      ? { ...publicRecords[index], relationLabels }
      : publicRecords[index];
  });
}

export function isRelationLookupCollection(value: LegacyCollection): value is RelationLookupCollection {
  return (RELATION_LOOKUP_COLLECTIONS as readonly LegacyCollection[]).includes(value);
}

export function relationTargetsForCollection(collection: LegacyCollection): RelationLookupCollection[] {
  return [...new Set(Object.values(relations[collection] ?? {}).map((definition) => definition.target))];
}

export async function listRelationOptions(collection: RelationLookupCollection): Promise<RelationOption[]> {
  const primaryLabel = labelFields[collection][0];
  const records = await getLegacyModel(collection)
    .find({ archivedAt: { $exists: false } })
    .sort({ [`raw.${primaryLabel}`]: 1, legacyId: 1 })
    .limit(5_000)
    .lean<LegacyRecord[]>();

  return records.flatMap((record) => {
    const id = relationId(record.legacyId ?? record.raw.id);
    if (id === null) return [];
    return [{ id, label: recordLabel(record, collection) }];
  });
}

async function loadLabels(collection: RelationLookupCollection, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const records = await getLegacyModel(collection)
    .find({ legacyId: { $in: ids }, archivedAt: { $exists: false } })
    .lean<LegacyRecord[]>();
  return new Map(records.flatMap((record) => {
    const id = relationId(record.legacyId ?? record.raw.id);
    return id === null ? [] : [[id, recordLabel(record, collection)] as const];
  }));
}

function recordLabel(record: LegacyRecord, collection: RelationLookupCollection): string {
  for (const field of labelFields[collection]) {
    const value = record.raw[field];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return `#${record.legacyId ?? record.raw.id ?? 'unknown'}`;
}

function relationId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function relationIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(relationId).filter((id): id is number => id !== null))];
}

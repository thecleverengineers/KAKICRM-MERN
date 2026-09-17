import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Search } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { type FieldDefinition, resourceById, readableCollectionName, readableFieldName, type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';

export function EntityPage({ resourceIdOverride }: { resourceIdOverride?: string }) {
  const { resourceId } = useParams();
  const collection = resourceIdOverride ?? resourceId ?? '';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<PublicRecord | null | undefined>(undefined);
  const configured = resourceById.get(collection);
  const activeProjectFilter = collection === 'department_projects' && searchParams.get('status') === 'active';
  const filterSignature = searchParams.toString();
  const recordFilters = useMemo(() => {
    const supported = ['status', 'risk', 'risk_level', 'department_id', 'project_id', 'client_id', 'billing_profile_id', 'payment_status', 'type', 'category'];
    const values = Object.fromEntries(supported.flatMap((key) => {
      const value = searchParams.get(key);
      return value ? [[key, /^\d+$/.test(value) ? Number(value) : value] as const] : [];
    }));
    return Object.keys(values).length ? JSON.stringify(values) : undefined;
  }, [searchParams]);
  useEffect(() => {
    setPage(1);
  }, [collection, filterSignature, activeProjectFilter]);
  const query = useQuery({
    queryKey: ['records', collection, page, search, filterSignature],
    enabled: Boolean(collection),
    queryFn: () => api<Paginated<PublicRecord>>(`/records/${encodeURIComponent(collection)}${queryString({ page, limit: 25, search, searchFields: configured?.searchFields?.join(','), filters: recordFilters })}`)
  });
  const resource = useMemo(() => configured ?? inferredResource(collection, query.data?.data ?? []), [collection, configured, query.data?.data]);
  if (!collection) return <ErrorState message="No data collection was selected." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const result = query.data;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['records', collection] });
  const save = async (fields: Record<string, unknown>) => {
    const result = editing
      ? await api<{ data: PublicRecord }>(`/records/${collection}/${editing.legacyId}`, { method: 'PATCH', body: JSON.stringify({ fields }) })
      : await api<{ data: PublicRecord }>(`/records/${collection}`, { method: 'POST', body: JSON.stringify({ fields }) });
    await invalidate();
    return result.data;
  };
  const archive = async (record: PublicRecord) => {
    if (!window.confirm(`Archive ${resource.singular.toLowerCase()} #${record.legacyId}? The original data will remain recoverable.`)) return;
    await api(`/records/${collection}/${record.legacyId}`, { method: 'DELETE' });
    await invalidate();
  };
  const openRecord = (record: PublicRecord) => {
    if (collection === 'users') {
      navigate(`/data/users/${record.legacyId}`);
      return;
    }
    if (collection === 'department_projects') {
      navigate(`/projects/${record.legacyId}`);
      return;
    }
    if (collection === 'teams') {
      navigate(`/data/teams/${record.legacyId}`);
      return;
    }
    navigate(`/data/${collection}/${record.legacyId}`);
  };
  const pageTitle = activeProjectFilter ? 'Active Projects' : resource.label;
  const pageDescription = activeProjectFilter
    ? 'Projects currently in progress across every department. Open a project to manage its team, tasks, files, project head and notes.'
    : resource.description;
  return <>
    <PageHeader eyebrow={activeProjectFilter ? 'PROJECT OPERATIONS' : 'DATA MANAGEMENT'} title={pageTitle} description={pageDescription} actions={<button className="button" onClick={() => setEditing(null)}><Plus size={17} /> New {resource.singular}</button>} />
    <div className="toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={`Search ${pageTitle.toLowerCase()}…`} /></label><span>{result.pagination.total} {activeProjectFilter ? 'active' : 'total'}</span></div>
    <DataTable records={result.data} columns={resource.columns} resource={resource} page={result.pagination.page} pages={result.pagination.pages} total={result.pagination.total} onPageChange={setPage} onOpen={openRecord} clickableRows={collection === 'users' || collection === 'department_projects' || collection === 'teams' || collection === 'billing_profiles'} onEdit={(record) => setEditing(record)} onArchive={archive} />
    <RecordFormDialog open={editing !== undefined} resource={resource} record={editing} onClose={() => setEditing(undefined)} onSubmit={save} />
  </>;
}

function inferredResource(collection: string, records: PublicRecord[]): ResourceConfig {
  const fields = Object.keys(records[0]?.fields ?? {}).filter((key) => !['id', 'password_hash'].includes(key)).slice(0, 16);
  const definitions: FieldDefinition[] = fields.map((key) => ({ key, label: readableFieldName(key), kind: inferKind(key) }));
  return { id: collection, label: readableCollectionName(collection), singular: readableCollectionName(collection).replace(/s$/, ''), description: 'Legacy records retained exactly as imported from the previous CRM.', icon: FileText, fields: definitions, columns: fields.slice(0, 7) };
}

function inferKind(key: string): FieldDefinition['kind'] {
  if (/(date|_at)$/i.test(key)) return 'date';
  if (/(amount|salary|fee|rate|qty|minutes|days|_id)$/i.test(key)) return 'number';
  if (/(notes|description|reason|body|requirements)$/i.test(key)) return 'textarea';
  if (/email/i.test(key)) return 'email';
  return 'text';
}

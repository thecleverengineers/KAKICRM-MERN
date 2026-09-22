import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Filter, Plus, X } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { SearchAutocomplete, useDebouncedValue } from '../components/SearchAutocomplete.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { type FieldDefinition, resourceById, readableCollectionName, readableFieldName, type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

export function EntityPage({ resourceIdOverride }: { resourceIdOverride?: string }) {
  const { resourceId } = useParams();
  const collection = resourceIdOverride ?? resourceId ?? '';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const suggestionSearch = useDebouncedValue(searchInput.trim());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [searchField, setSearchField] = useState('');
  const [searchMode, setSearchMode] = useState<'all' | 'any'>('all');
  const [sortField, setSortField] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
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
    if (statusFilter && !values.status) values.status = statusFilter;
    return Object.keys(values).length ? JSON.stringify(values) : undefined;
  }, [searchParams, statusFilter]);
  useEffect(() => {
    setPage(1);
  }, [collection, filterSignature, activeProjectFilter]);
  const query = useQuery({
    queryKey: ['records', collection, page, search, filterSignature, searchField, searchMode, sortField, sortOrder, includeArchived],
    enabled: Boolean(collection),
    queryFn: () => api<Paginated<PublicRecord>>(`/records/${encodeURIComponent(collection)}${queryString({ page, limit: 25, search, searchFields: searchField || configured?.searchFields?.join(','), searchMode, sort: sortField || undefined, order: sortOrder, filters: recordFilters, includeArchived })}`)
  });
  const suggestionsQuery = useQuery({
    queryKey: ['record-search-suggestions', collection, suggestionSearch, filterSignature, searchField, searchMode, sortField, sortOrder, includeArchived],
    enabled: Boolean(collection) && suggestionSearch.length > 0 && suggestionSearch === searchInput.trim(),
    staleTime: 30_000,
    queryFn: () => api<Paginated<PublicRecord>>(`/records/${encodeURIComponent(collection)}${queryString({ page: 1, limit: 6, search: suggestionSearch, searchFields: searchField || configured?.searchFields?.join(','), searchMode, sort: sortField || undefined, order: sortOrder, filters: recordFilters, includeArchived })}`)
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
  const searchableFields = configured?.fields ?? [];
  const canIncludeArchived = hasPermission('*') || hasPermission('rbac.manage');
  const clearAdvanced = () => { setSearchField(''); setSearchMode('all'); setSortField(''); setSortOrder('desc'); setStatusFilter(''); setIncludeArchived(false); setPage(1); };
  return <>
    <PageHeader eyebrow={activeProjectFilter ? 'PROJECT OPERATIONS' : 'DATA MANAGEMENT'} title={pageTitle} description={pageDescription} actions={<button className="button" onClick={() => setEditing(null)}><Plus size={17} /> New {resource.singular}</button>} />
    <div className="toolbar advanced-search-toolbar"><div className="advanced-search-main"><SearchAutocomplete
      className="search-autocomplete--entity"
      value={searchInput}
      onChange={setSearchInput}
      onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }}
      suggestions={suggestionsQuery.data?.data ?? []}
      getKey={(record) => record.id}
      getLabel={(record) => String(record.fields.title ?? record.fields.name ?? record.fields.invoice_no ?? record.fields.legal_name ?? record.fields.email ?? `Record #${record.legacyId ?? ''}`)}
      getDetail={(record) => [resource.singular, record.legacyId ? `#${record.legacyId}` : '', record.fields.status ? String(record.fields.status).replaceAll('_', ' ') : ''].filter(Boolean).join(' · ')}
      onSelect={openRecord}
      loading={searchInput.trim().length > 0 && (suggestionSearch !== searchInput.trim() || suggestionsQuery.isFetching || suggestionsQuery.isPending)}
      error={suggestionsQuery.isError}
      placeholder={`Search ${pageTitle.toLowerCase()}…`}
    /><button type="button" className={`button button--secondary advanced-search-toggle${advancedOpen ? ' is-active' : ''}`} onClick={() => setAdvancedOpen((current) => !current)}><Filter size={16} /> Advanced {advancedOpen ? <X size={14} /> : null}</button></div><span>{result.pagination.total} {activeProjectFilter ? 'active' : 'total'}</span></div>
    {advancedOpen && <section className="advanced-search-panel content-card"><div className="advanced-search-grid"><label className="field"><span>Search fields</span><select value={searchField} onChange={(event) => { setSearchField(event.target.value); setPage(1); }}><option value="">Configured fields</option>{searchableFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label><label className="field"><span>Match mode</span><select value={searchMode} onChange={(event) => { setSearchMode(event.target.value as 'all' | 'any'); setPage(1); }}><option value="all">All terms</option><option value="any">Any term</option></select></label><label className="field"><span>Sort by</span><select value={sortField} onChange={(event) => { setSortField(event.target.value); setPage(1); }}><option value="">Recently updated</option>{searchableFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></label><label className="field"><span>Order</span><select value={sortOrder} onChange={(event) => { setSortOrder(event.target.value as 'asc' | 'desc'); setPage(1); }}><option value="desc">Newest / Z–A</option><option value="asc">Oldest / A–Z</option></select></label><label className="field"><span>Status filter</span><input value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} placeholder="e.g. active, pending" /></label>{canIncludeArchived && <label className="toggle-field advanced-search-archive"><input type="checkbox" checked={includeArchived} onChange={(event) => { setIncludeArchived(event.target.checked); setPage(1); }} /><span>Include archived</span></label>}</div><div className="advanced-search-help">Search supports multiple terms, quoted phrases, and field filters such as <code>status:active</code> or <code>email:gmail.com</code>.<button type="button" className="text-button" onClick={clearAdvanced}>Reset advanced search</button></div></section>}
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

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { SearchAutocomplete, useDebouncedValue } from '../components/SearchAutocomplete.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, apiUrl, getAccessToken, type Paginated, type PublicRecord, type RelationOption, queryString } from '../lib/api.js';
import { CUSTOM_INVOICE_UNIT, INVOICE_UNITS, resolvedUnit } from '../lib/invoiceUnits.js';
import { useAuth } from '../store/auth.js';

const invoiceResource: ResourceConfig = {
  id: 'invoices', label: 'Invoices', singular: 'Invoice', description: 'Create, issue, print and reconcile invoices with their payments.', icon: Plus, permission: 'billing.view',
  columns: ['invoice_no', 'client_id', 'issue_date', 'due_date', 'total_amount', 'paid_amount', 'balance_amount', 'status'], fields: [{ key: 'client_id', label: 'Client', kind: 'relation', relation: 'clients' }]
};

export function InvoicesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const suggestionSearch = useDebouncedValue(searchInput.trim());
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMode, setExportMode] = useState<'all' | 'filtered' | null>(null);
  const [exportFromDate, setExportFromDate] = useState('');
  const [exportToDate, setExportToDate] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const query = useQuery({ queryKey: ['invoices', page, search], queryFn: () => api<Paginated<PublicRecord>>(`/billing/invoices${queryString({ page, limit: 50, search })}`) });
  const suggestionsQuery = useQuery({
    queryKey: ['invoice-search-suggestions', suggestionSearch],
    enabled: suggestionSearch.length > 0 && suggestionSearch === searchInput.trim(),
    staleTime: 30_000,
    queryFn: () => api<Paginated<PublicRecord>>(`/billing/invoices${queryString({ page: 1, limit: 6, search: suggestionSearch })}`)
  });
  if (query.isPending) return <LoadingState label="Loading invoices…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const canCreateInvoice = hasPermission('billing.manage');
  const exportInvoices = async (mode: 'all' | 'filtered'): Promise<void> => {
    if (exportFromDate && exportToDate && exportFromDate > exportToDate) {
      setExportError('From date cannot be later than To date.');
      return;
    }
    setExporting(true);
    setExportMode(mode);
    setExportError(null);
    try {
      const token = getAccessToken();
      const response = await fetch(apiUrl(`/billing/invoices/export${queryString({ search: mode === 'filtered' ? search : undefined, export_scope: mode, from_date: exportFromDate, to_date: exportToDate })}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Could not export invoices.');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const disposition = response.headers.get('Content-Disposition');
      const fileName = disposition?.match(/filename="([^"]+)"/i)?.[1] ?? `kaki-invoices-${mode}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (problem) {
      setExportError(problem instanceof Error ? problem.message : 'Could not export invoices.');
    } finally {
      setExporting(false);
      setExportMode(null);
    }
  };
  return <>
    <PageHeader eyebrow="FINANCE" title="Invoices" description="A single source of truth for client billing, line items, tax, payment and printable invoice records." actions={canCreateInvoice ? <button className="button" type="button" onClick={() => setOpen(true)}><Plus size={17} /> New invoice</button> : undefined} />
    <div className="toolbar invoice-toolbar"><SearchAutocomplete
      className="search-autocomplete--invoice"
      value={searchInput}
      onChange={setSearchInput}
      onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }}
      suggestions={suggestionsQuery.data?.data ?? []}
      getKey={(invoice) => invoice.id}
      getLabel={(invoice) => String(invoice.fields.invoice_no ?? `Invoice #${invoice.legacyId ?? ''}`)}
      getDetail={(invoice) => [invoice.fields.status ? String(invoice.fields.status) : '', invoice.relationLabels?.client_id ? String(invoice.relationLabels.client_id) : '', invoice.fields.total_amount !== undefined ? String(invoice.fields.total_amount) : ''].filter(Boolean).join(' · ')}
      onSelect={(invoice) => { if (invoice.legacyId) navigate(`/invoices/${invoice.legacyId}`); }}
      loading={searchInput.trim().length > 0 && (suggestionSearch !== searchInput.trim() || suggestionsQuery.isFetching || suggestionsQuery.isPending)}
      error={suggestionsQuery.isError}
      placeholder="Search invoice number, client or status…"
    /><div className="invoice-export-controls"><label><span>From</span><input type="date" value={exportFromDate} onChange={(event) => setExportFromDate(event.target.value)} /></label><label><span>To</span><input type="date" value={exportToDate} onChange={(event) => setExportToDate(event.target.value)} /></label><button className="button button--secondary button--compact" type="button" onClick={() => void exportInvoices('all')} disabled={exporting} title="Export every invoice in the selected date range">{exporting && exportMode === 'all' ? <LoaderCircle size={15} className="spin" /> : <FileDown size={15} />} {exporting && exportMode === 'all' ? 'Preparing…' : 'Export all'}</button><button className="button button--secondary button--compact" type="button" onClick={() => void exportInvoices('filtered')} disabled={exporting} title="Export invoices matching the search and selected date range">{exporting && exportMode === 'filtered' ? <LoaderCircle size={15} className="spin" /> : <FileDown size={15} />} {exporting && exportMode === 'filtered' ? 'Preparing…' : 'Export filtered'}</button><span>{query.data.pagination.total} invoices</span></div></div>
    {exportError && <p className="form-error">{exportError}</p>}
    <DataTable records={query.data.data} columns={invoiceResource.columns} resource={invoiceResource} page={query.data.pagination.page} pages={query.data.pagination.pages} total={query.data.pagination.total} onPageChange={setPage} onOpen={(record) => navigate(`/invoices/${record.legacyId}`)} clickableRows />
    {canCreateInvoice && <CreateInvoiceDialog open={open} onClose={() => setOpen(false)} onCreated={async () => { await queryClient.invalidateQueries({ queryKey: ['invoices'] }); }} />}
  </>;
}

function CreateInvoiceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [clients, setClients] = useState<RelationOption[]>([]);
  const [profiles, setProfiles] = useState<PublicRecord[]>([]);
  const [clientId, setClientId] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const [billingProfileId, setBillingProfileId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [label, setLabel] = useState('Professional services');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState<string>(INVOICE_UNITS[0]);
  const [customUnit, setCustomUnit] = useState('');
  const [rate, setRate] = useState('');
  const [gst, setGst] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setClientId('');
    setClientSearch('');
    setClientPickerOpen(false);
    void Promise.all([
      api<{ data: RelationOption[] }>('/records/lookups/invoices/clients'),
      api<Paginated<PublicRecord>>('/records/billing_profiles?limit=100')
    ]).then(([clientResult, profileResult]) => {
      setClients(clientResult.data);
      setProfiles(profileResult.data);
    }).catch((problem: unknown) => setError(problem instanceof Error ? problem.message : 'Could not load clients and company profiles.'));
  }, [open]);

  if (!open) return null;
  const selectedProfile = profiles.find((profile) => String(profile.legacyId) === billingProfileId);
  const selectedProfileGst = selectedProfile ? profileGstEnabled(selectedProfile.fields) : null;
  const selectedClient = clients.find((client) => String(client.id) === clientId);
  const normalizedClientSearch = clientSearch.trim().toLowerCase();
  const matchingClients = normalizedClientSearch
    ? clients.filter((client) => client.label.toLowerCase().includes(normalizedClientSearch))
    : [];
  const selectClient = (client: RelationOption) => {
    setClientId(String(client.id));
    setClientSearch(client.label);
    setClientPickerOpen(false);
    setError(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clientId) {
      setError('Search for and select a client before creating the invoice.');
      return;
    }
    const finalUnit = resolvedUnit(unit, customUnit);
    if (!finalUnit) {
      setError('Enter the custom unit name.');
      return;
    }
    const numericQty = wholeQuantityValue(qty);
    if (numericQty === null) {
      setError('Quantity must be a whole number between 1 and 1,000,000.');
      return;
    }
    setSaving(true); setError(null);
    try {
      await api('/billing/invoices', { method: 'POST', body: JSON.stringify({ client_id: Number(clientId), billing_profile_id: Number(billingProfileId), issue_date: issueDate, due_date: dueDate || null, gst_enabled: gst, gst_percent: 18, discount_type: 'none', discount_value: 0, items: [{ label, description: description || null, qty: numericQty, rate: Number(rate), unit: finalUnit }] }) });
      await onCreated(); onClose();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not create the invoice.'); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><p className="eyebrow">FINANCE</p><h2>New invoice</h2></div></div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <div className="field field--wide invoice-client-field"><span>Client *</span><div className="invoice-client-picker"><div className="invoice-client-picker__control"><Search size={16} aria-hidden="true" /><input id="invoice-client-search" value={clientSearch} onFocus={() => setClientPickerOpen(true)} onChange={(event) => { const nextValue = event.target.value; setClientSearch(nextValue); setClientPickerOpen(true); if (!selectedClient || nextValue !== selectedClient.label) setClientId(''); }} onBlur={() => { window.setTimeout(() => setClientPickerOpen(false), 120); }} placeholder="Search clients by name…" autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={clientPickerOpen && Boolean(normalizedClientSearch)} aria-controls="invoice-client-options" aria-required="true" />{clientId && <button type="button" className="invoice-client-picker__clear" onMouseDown={(event) => event.preventDefault()} onClick={() => { setClientId(''); setClientSearch(''); setClientPickerOpen(true); }} aria-label="Clear selected client"><X size={15} /></button>}</div>{clientPickerOpen && normalizedClientSearch && <div id="invoice-client-options" className="invoice-client-picker__options" role="listbox">{matchingClients.slice(0, 50).map((client) => <button type="button" role="option" aria-selected={String(client.id) === clientId} className={`invoice-client-picker__option${String(client.id) === clientId ? ' invoice-client-picker__option--selected' : ''}`} key={client.id} onMouseDown={(event) => { event.preventDefault(); selectClient(client); }} onClick={() => selectClient(client)}><span>{client.label}</span><small>Client #{client.id}</small></button>)}{!matchingClients.length && <div className="invoice-client-picker__empty">No clients match “{clientSearch.trim()}”.</div>}{matchingClients.length > 50 && <div className="invoice-client-picker__more">Showing the first 50 matches. Refine your search to see more.</div>}</div>}</div>{selectedClient && <small>Selected client: {selectedClient.label}</small>}{!selectedClient && clients.length > 0 && <small>Type a client name and select a result.</small>}</div>
          <label className="field"><span>Company profile *</span><select value={billingProfileId} onChange={(event) => { const selectedId = event.target.value; setBillingProfileId(selectedId); const profile = profiles.find((candidate) => String(candidate.legacyId) === selectedId); setGst(profile ? profileGstEnabled(profile.fields) ?? false : false); }} required><option value="">Select company profile…</option>{profiles.map((profile) => <option key={profile.id} value={profile.legacyId ?? ''}>{companyProfileLabel(profile)}</option>)}</select><small>The invoice will use this profile’s logo, legal name, address, GSTIN, phone and email.</small></label>
          <label className="field"><span>Issue date *</span><input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required /></label>
          <label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
          <label className="field field--wide"><span>Item *</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={255} required /></label>
          <label className="field field--wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} /></label>
          <label className="field"><span>Quantity *</span><input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={7} value={qty} onChange={(event) => { if (/^\d*$/.test(event.target.value)) setQty(event.target.value); }} placeholder="e.g. 1" title="Whole numbers only" required /></label>
          <label className="field"><span>Unit *</span><select value={unit} onChange={(event) => setUnit(event.target.value)} required>{INVOICE_UNITS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          {unit === CUSTOM_INVOICE_UNIT && <label className="field"><span>Custom unit *</span><input value={customUnit} onChange={(event) => setCustomUnit(event.target.value)} maxLength={30} required /></label>}
          <label className="field"><span>Rate *</span><input type="number" min="0" max="100000000" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} required /></label>
          <label className="toggle-field"><input type="checkbox" checked={gst} disabled={selectedProfileGst === false} onChange={(event) => setGst(event.target.checked)} /><span>{selectedProfileGst === false ? 'GST disabled in selected profile' : 'Apply 18% GST'}</span></label>
        </div>
        {!profiles.length && !error && <p className="form-error">Create a Billing Profile first, then select it here to issue a company-specific invoice.</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button className="button" disabled={saving || !profiles.length}>{saving ? 'Creating…' : 'Create invoice'}</button></div>
      </form>
    </section>
  </div>;
}

function companyProfileLabel(profile: PublicRecord): string {
  const fields = profile.fields;
  return String(fields.legal_name || fields.business_name || fields.brand_name || fields.code || `Company profile #${profile.legacyId}`);
}

function wholeQuantityValue(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : null;
}

function profileGstEnabled(fields: Record<string, unknown>): boolean | null {
  for (const value of [fields.gst_enabled, fields.gst_default_enabled, fields.gst_registered, fields.gst_applicable]) {
    if (value === null || value === undefined || value === '') continue;
    if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes' || String(value).toLowerCase() === 'enabled') return true;
    if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false' || String(value).toLowerCase() === 'no' || String(value).toLowerCase() === 'disabled') return false;
  }
  return null;
}

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, Link2, LockKeyhole, MessageCircle, Pencil, Plus, RefreshCw, Send, Trash2, X } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';
import './whatsappBusiness.css';

interface Phone { key: string; displayPhoneNumber: string | null; verifiedName: string | null; activationStatus: string | null; qualityRating: string | null; codeVerificationStatus: string | null; platformType: string | null }
interface Account { id: string; name: string; connected: boolean; phones: Phone[]; createdAt: string | null; updatedAt: string | null; lastVerifiedAt: string | null }
interface Template { id: string; name: string; status: string; category: string | null; language: string | null; components: unknown[]; qualityScore: unknown; rejectedReason: string | null; parameterFormat: string | null; editable: boolean }
interface TemplateDraft { name: string; category: string; language: string; components: string }

const MANAGER_ROLES = ['admin', 'administrator', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'manager', 'ceo', 'chief_executive_officer', 'chief_executive'];
const DEFAULT_COMPONENTS = '[\n  {\n    "type": "BODY",\n    "text": "Hello {{1}}, your update is ready."\n  }\n]';
const basePath = '/settings/integrations/whatsapp-business';

export function WhatsAppBusinessSettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const role = String(user?.role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed = MANAGER_ROLES.includes(role);
  const [selectedId, setSelectedId] = useState('');
  const [accountEditor, setAccountEditor] = useState<'new' | string | null>(null);
  const [templateEditor, setTemplateEditor] = useState<'new' | Template | null>(null);
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const accountsQuery = useQuery({ queryKey: ['whatsapp-business-accounts'], enabled: allowed, queryFn: async () => (await api<{ data: Account[] }>(basePath)).data });
  const accounts = accountsQuery.data ?? [];
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0] ?? null;
  const templateQuery = useQuery({ queryKey: ['whatsapp-business-templates', selected?.id], enabled: allowed && Boolean(selected?.id), queryFn: async () => (await api<{ data: Template[] }>(`${basePath}/${selected!.id}/templates`)).data });

  useEffect(() => { if (selected && selected.id !== selectedId) setSelectedId(selected.id); }, [selected, selectedId]);
  const saveAccount = useMutation({
    mutationFn: async (payload: { id?: string; name: string; accessToken?: string; wabaId?: string }) => {
      const { id, ...body } = payload;
      return api<{ data: Account }>(id ? `${basePath}/${id}` : basePath, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    },
    onSuccess: (response) => { setAccountEditor(null); setNotice({ type: 'success', text: 'WhatsApp Business account saved and verified with Meta.' }); setSelectedId(response.data.id); void queryClient.invalidateQueries({ queryKey: ['whatsapp-business-accounts'] }); }
  });
  const deleteAccount = useMutation({
    mutationFn: (id: string) => api<{ data: { id: string } }>(`${basePath}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setSelectedId(''); setNotice({ type: 'success', text: 'Account removed and its saved credentials deleted.' }); void queryClient.invalidateQueries({ queryKey: ['whatsapp-business-accounts'] }); }
  });
  const refreshAccount = useMutation({
    mutationFn: (id: string) => api<{ data: Account }>(`${basePath}/${id}/refresh`, { method: 'POST' }),
    onSuccess: (response) => { setNotice({ type: 'success', text: 'Phone activation status refreshed from Meta.' }); queryClient.setQueryData<Account[]>(['whatsapp-business-accounts'], (current = []) => current.map((row) => row.id === response.data.id ? response.data : row)); }
  });
  const saveTemplate = useMutation({
    mutationFn: async (payload: { accountId: string; draft: TemplateDraft; templateId?: string }) => {
      const components = parseComponents(payload.draft.components);
      const body = payload.templateId ? { components } : { name: payload.draft.name, category: payload.draft.category, language: payload.draft.language, components };
      return api<{ data: Template }>(payload.templateId ? `${basePath}/${payload.accountId}/templates/${payload.templateId}` : `${basePath}/${payload.accountId}/templates`, { method: payload.templateId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    },
    onSuccess: () => { setTemplateEditor(null); setNotice({ type: 'success', text: 'Template request sent to Meta. Its approval status will update from Meta.' }); void queryClient.invalidateQueries({ queryKey: ['whatsapp-business-templates', selected?.id] }); }
  });
  const deleteTemplate = useMutation({
    mutationFn: ({ accountId, templateId }: { accountId: string; templateId: string }) => api(`${basePath}/${accountId}/templates/${templateId}`, { method: 'DELETE' }),
    onSuccess: () => { setNotice({ type: 'success', text: 'Template deleted from Meta.' }); void queryClient.invalidateQueries({ queryKey: ['whatsapp-business-templates', selected?.id] }); }
  });
  const mutationError = saveAccount.error ?? deleteAccount.error ?? refreshAccount.error ?? saveTemplate.error ?? deleteTemplate.error;
  const templates = useMemo(() => templateQuery.data ?? [], [templateQuery.data]);

  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (accountsQuery.isPending) return <LoadingState label="Loading WhatsApp Business accounts…" />;
  if (accountsQuery.isError) return <ErrorState message={accountsQuery.error.message} onRetry={() => void accountsQuery.refetch()} />;

  const submitAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setNotice(null);
    const form = new FormData(event.currentTarget);
    const editing = accountEditor !== 'new';
    const payload: { id?: string; name: string; accessToken?: string; wabaId?: string } = { name: String(form.get('name') ?? '').trim() };
    if (editing) payload.id = String(accountEditor);
    const token = String(form.get('accessToken') ?? '').trim();
    const wabaId = String(form.get('wabaId') ?? '').trim();
    if (!editing || token || wabaId) { payload.accessToken = token; payload.wabaId = wabaId; }
    saveAccount.mutate(payload);
  };
  const submitTemplate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setNotice(null);
    const form = new FormData(event.currentTarget);
    saveTemplate.mutate({ accountId: selected!.id, templateId: templateEditor === 'new' ? undefined : templateEditor?.id, draft: { name: String(form.get('name') ?? '').trim(), category: String(form.get('category') ?? 'UTILITY'), language: String(form.get('language') ?? 'en_US'), components: String(form.get('components') ?? '') } });
  };

  const editingAccount = typeof accountEditor === 'string' ? accounts.find((row) => row.id === accountEditor) : null;
  const editingTemplate = templateEditor && templateEditor !== 'new' ? templateEditor : null;
  return <>
    <PageHeader eyebrow="COMPANY INTEGRATIONS" title="WhatsApp Business gateway" description="Connect and manage multiple Meta businesses, monitor phone activation, and manage approved message templates." />
    <section className="content-card whatsapp-business-card whatsapp-gateway">
      <div className="card-heading"><div><p className="eyebrow">META CLOUD API</p><h2>Business accounts</h2><p className="muted-copy">Admins, HR, managers, and the CEO can manage shared company connections.</p></div><MessageCircle size={22} /></div>
      {notice && <div className={`whatsapp-notice whatsapp-notice--${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.type === 'error' ? <CircleAlert size={17} /> : <Check size={17} />}</span>{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={15} /></button></div>}
      {mutationError && <div className="whatsapp-notice whatsapp-notice--error" role="alert"><CircleAlert size={17} />{mutationError instanceof Error ? mutationError.message : 'The request could not be completed.'}<button type="button" aria-label="Dismiss message" onClick={() => { saveAccount.reset(); deleteAccount.reset(); refreshAccount.reset(); saveTemplate.reset(); deleteTemplate.reset(); }}><X size={15} /></button></div>}
      <div className="whatsapp-account-toolbar"><label className="field"><span>Selected business account</span><span className="whatsapp-select-wrap"><select value={selected?.id ?? ''} onChange={(event) => { setSelectedId(event.target.value); setNotice(null); }} disabled={!accounts.length}><option value="" disabled>{accounts.length ? 'Choose an account' : 'No accounts connected'}</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select><ChevronDown size={16} /></span></label><button className="button" type="button" onClick={() => { setAccountEditor('new'); setNotice(null); }}><Plus size={16} /> Add business</button></div>
      {!selected ? <div className="whatsapp-empty"><span><Link2 size={22} /></span><h3>No WhatsApp Business account yet</h3><p>Connect a Meta business account to list its registered phone numbers and manage message templates.</p><button className="button" type="button" onClick={() => setAccountEditor('new')}><Plus size={16} /> Connect account</button></div> : <>
        <article className="whatsapp-account-card">
          <div className="whatsapp-account-card__top"><div className="whatsapp-account-identity"><span className={`whatsapp-connection-icon${selected.connected ? ' is-connected' : ''}`}>{selected.connected ? <Check size={18} /> : <Link2 size={18} />}</span><div><h3>{selected.name}</h3><p>{selected.connected ? 'Connected to Meta' : 'Connection needs attention'}{selected.lastVerifiedAt ? ` · Last verified ${selected.lastVerifiedAt}` : ''}</p></div></div><div className="whatsapp-account-actions"><button className="button button--secondary" type="button" onClick={() => { setAccountEditor(selected.id); setNotice(null); }}><Pencil size={15} /> Edit</button><button className="button button--secondary" type="button" onClick={() => refreshAccount.mutate(selected.id)} disabled={refreshAccount.isPending}><RefreshCw size={15} /> {refreshAccount.isPending ? 'Refreshing…' : 'Refresh status'}</button><button className="button button--danger" type="button" onClick={() => { if (window.confirm(`Remove ${selected.name} and delete its saved Meta credentials?`)) deleteAccount.mutate(selected.id); }} disabled={deleteAccount.isPending}><Trash2 size={15} /> Remove</button></div></div>
          <div className="whatsapp-phones"><div className="whatsapp-section-title"><div><h4>Phone numbers</h4><p>Activation status reported by Meta</p></div><span className="whatsapp-count">{selected.phones.length}</span></div>{selected.phones.length ? <div className="whatsapp-phone-grid">{selected.phones.map((phone) => <div className="whatsapp-phone" key={phone.key}><div className="whatsapp-phone__heading"><strong>{phone.displayPhoneNumber ?? 'Phone number'}</strong><span className={`whatsapp-status-pill ${statusClass(phone.activationStatus)}`}>{phone.activationStatus ?? 'Unknown'}</span></div><p>{phone.verifiedName ?? 'WhatsApp Business number'}{phone.platformType ? ` · ${phone.platformType}` : ''}</p><div className="whatsapp-phone__meta"><span>Quality: {phone.qualityRating ?? '—'}</span><span>Verification: {phone.codeVerificationStatus ?? '—'}</span></div></div>)}</div> : <p className="whatsapp-inline-empty">Meta did not return any phone numbers for this account.</p>}</div>
        </article>
        <div className="whatsapp-templates">
          <div className="whatsapp-section-title whatsapp-section-title--templates"><div><h3>Message templates</h3><p>View approval and activation status, create templates, and edit eligible templates.</p></div><div className="whatsapp-template-actions"><button className="button button--secondary" type="button" onClick={() => void templateQuery.refetch()} disabled={templateQuery.isFetching}><RefreshCw size={15} /> Refresh</button><button className="button" type="button" onClick={() => { setTemplateEditor('new'); setNotice(null); }}><Plus size={16} /> New template</button></div></div>
          {templateQuery.isPending ? <LoadingState label="Loading templates from Meta…" /> : templateQuery.isError ? <ErrorState message={templateQuery.error.message} onRetry={() => void templateQuery.refetch()} /> : templates.length === 0 ? <div className="whatsapp-inline-empty">No message templates were returned for this account.</div> : <div className="whatsapp-template-list">{templates.map((template) => <article className="whatsapp-template" key={template.id}><div className="whatsapp-template__main"><div className="whatsapp-template__heading"><h4>{template.name}</h4><span className={`whatsapp-status-pill ${statusClass(template.status)}`}>{template.status}</span></div><p>{template.category ?? 'Uncategorized'} · {template.language ?? 'Language unavailable'}{template.qualityScore ? ` · Quality ${typeof template.qualityScore === 'string' ? template.qualityScore : JSON.stringify(template.qualityScore)}` : ''}</p>{template.rejectedReason && <p className="whatsapp-template__rejected">Meta: {template.rejectedReason}</p>}<details><summary>Components</summary><pre>{JSON.stringify(template.components, null, 2)}</pre></details></div><div className="whatsapp-template__actions"><button className="button button--secondary" type="button" onClick={() => { setTemplateEditor(template); setNotice(null); }} disabled={!template.editable} title={template.editable ? 'Edit template components' : 'Meta allows editing approved or rejected templates only'}><Pencil size={15} /> Edit</button><button className="button button--danger" type="button" onClick={() => { if (window.confirm(`Delete the Meta template “${template.name}”?`)) deleteTemplate.mutate({ accountId: selected.id, templateId: template.id }); }}><Trash2 size={15} /> Delete</button></div></article>)}</div>}
        </div>
      </>}
      <div className="whatsapp-business-security-note"><LockKeyhole size={16} /><p>Access tokens, WhatsApp Business Account IDs, and phone number IDs are encrypted on the server. They are never returned to the browser or stored in browser storage.</p></div>
      <p className="integration-note">Templates are managed by Meta. Submission does not activate a template; Meta reviews it and reports the approval status here. Template edits are available when Meta marks a template approved or rejected. Sending messages and bulk campaigns are not part of this gateway screen.</p>
    </section>
    {accountEditor && <div className="whatsapp-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountEditor(null); }}><section className="whatsapp-modal" role="dialog" aria-modal="true" aria-labelledby="whatsapp-account-modal-title"><div className="whatsapp-modal__heading"><div><p className="eyebrow">META CLOUD API</p><h2 id="whatsapp-account-modal-title">{editingAccount ? 'Edit business account' : 'Connect a business account'}</h2></div><button className="whatsapp-icon-button" type="button" aria-label="Close" onClick={() => setAccountEditor(null)}><X size={18} /></button></div><form className="whatsapp-modal-form" onSubmit={(event) => void submitAccount(event)}><label className="field"><span>Account label</span><input name="name" defaultValue={editingAccount?.name ?? ''} autoComplete="organization" required minLength={2} maxLength={100} placeholder="e.g. Kaki Support" /></label><label className="field"><span>Meta system-user access token</span><input name="accessToken" type="password" autoComplete="new-password" required={!editingAccount} minLength={20} maxLength={4096} placeholder={editingAccount ? 'Leave blank to keep saved token' : 'Paste the Meta access token'} /></label><label className="field"><span>WhatsApp Business Account ID</span><input name="wabaId" inputMode="numeric" pattern="[0-9]{5,32}" autoComplete="off" required={!editingAccount} placeholder={editingAccount ? 'Leave blank to keep saved account' : 'Numeric WABA ID from Meta'} /></label>{editingAccount && <p className="integration-note">To replace credentials, enter both the new access token and WABA ID. Phone numbers will be reloaded from Meta.</p>}<div className="whatsapp-modal__actions"><button className="button button--secondary" type="button" onClick={() => setAccountEditor(null)}>Cancel</button><button className="button" type="submit" disabled={saveAccount.isPending}><Check size={16} /> {saveAccount.isPending ? 'Verifying with Meta…' : editingAccount ? 'Save account' : 'Verify and connect'}</button></div></form></section></div>}
    {templateEditor && selected && <div className="whatsapp-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplateEditor(null); }}><section className="whatsapp-modal whatsapp-modal--wide" role="dialog" aria-modal="true" aria-labelledby="whatsapp-template-modal-title"><div className="whatsapp-modal__heading"><div><p className="eyebrow">META MESSAGE TEMPLATES</p><h2 id="whatsapp-template-modal-title">{editingTemplate ? `Edit ${editingTemplate.name}` : 'Create a template'}</h2></div><button className="whatsapp-icon-button" type="button" aria-label="Close" onClick={() => setTemplateEditor(null)}><X size={18} /></button></div><form className="whatsapp-modal-form" onSubmit={(event) => void submitTemplate(event)}>{!editingTemplate && <div className="whatsapp-template-form-grid"><label className="field"><span>Template name</span><input name="name" required pattern="[a-z0-9_]{1,512}" maxLength={512} placeholder="order_update" /><small>Lowercase letters, numbers, and underscores.</small></label><label className="field"><span>Category</span><select name="category"><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Authentication</option></select></label><label className="field"><span>Language</span><input name="language" defaultValue="en_US" required pattern="[a-z]{2,3}(_[A-Z]{2})?" maxLength={20} placeholder="en_US" /></label></div>}<label className="field"><span>Template components (JSON)</span><textarea name="components" defaultValue={editingTemplate ? JSON.stringify(editingTemplate.components, null, 2) : DEFAULT_COMPONENTS} required rows={12} spellCheck={false} /></label><p className="integration-note">Provide Meta template components such as HEADER, BODY, FOOTER, and BUTTONS. Meta validates each submission before activation.</p><div className="whatsapp-modal__actions"><button className="button button--secondary" type="button" onClick={() => setTemplateEditor(null)}>Cancel</button><button className="button" type="submit" disabled={saveTemplate.isPending}><Send size={15} /> {saveTemplate.isPending ? 'Submitting…' : editingTemplate ? 'Submit edit' : 'Submit to Meta'}</button></div></form></section></div>}
  </>;
}

function parseComponents(value: string): Record<string, unknown>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Template components must be valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10 || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('Components must be a JSON array of 1 to 10 component objects.');
  return parsed as Record<string, unknown>[];
}

function statusClass(status: string | null): string {
  const normalized = String(status ?? '').toUpperCase();
  if (['CONNECTED', 'ACTIVE', 'APPROVED', 'REGISTERED', 'CONNECTED'].includes(normalized)) return 'whatsapp-status-pill--good';
  if (['PENDING', 'IN_REVIEW', 'FLAGGED', 'IN_APPEAL'].includes(normalized)) return 'whatsapp-status-pill--pending';
  if (['REJECTED', 'DISCONNECTED', 'FAILED', 'DISABLED', 'BANNED'].includes(normalized)) return 'whatsapp-status-pill--bad';
  return '';
}

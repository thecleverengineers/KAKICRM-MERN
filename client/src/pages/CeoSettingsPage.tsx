import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, KeyRound, LockKeyhole, Save, ShieldAlert } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api } from '../lib/api.js';
import { isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

interface CeoSettings {
  expenseApprovalAbove: number;
  discountApprovalAbove: number;
  salaryIncrementApprovalAbove: number;
  departmentHeadApprovalLimit: number;
  projectBudgetOverrunApproval: boolean;
  invoiceCancellationApproval: boolean;
  highPriorityHiringApproval: boolean;
  financialYear: string;
  defaultReportFormat: 'pdf' | 'xlsx' | 'csv';
  dashboardWidgets: string[];
}
interface GoogleOAuthStatus { configured: boolean; source: 'settings' | 'environment' | 'not_configured'; clientId: string | null; redirectUri: string | null; projectId: string | null; storedClientSecret: boolean; updatedAt: string | null }

const fallback: CeoSettings = { expenseApprovalAbove: 50_000, discountApprovalAbove: 15, salaryIncrementApprovalAbove: 10, departmentHeadApprovalLimit: 50_000, projectBudgetOverrunApproval: true, invoiceCancellationApproval: true, highPriorityHiringApproval: true, financialYear: '2026-27', defaultReportFormat: 'pdf', dashboardWidgets: [] };
const productionGoogleRedirectUri = 'https://www.kakicrm.store/api/integrations/google/callback';

export function CeoSettingsPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.settings.view');
  const [form, setForm] = useState<CeoSettings>(fallback);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleClientId, setGoogleClientId] = useState(''); const [googleClientSecret, setGoogleClientSecret] = useState(''); const [googleRedirectUri, setGoogleRedirectUri] = useState(productionGoogleRedirectUri); const [googleProjectId, setGoogleProjectId] = useState(''); const [googleSaving, setGoogleSaving] = useState(false); const [googleSaved, setGoogleSaved] = useState(false); const [googleError, setGoogleError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['ceo-settings'], enabled: allowed, queryFn: () => api<{ data: CeoSettings }>('/ceo/settings') });
  const googleQuery = useQuery({ queryKey: ['ceo-google-oauth'], enabled: allowed, queryFn: () => api<{ data: GoogleOAuthStatus }>('/ceo/google-oauth') });
  useEffect(() => { if (query.data?.data) setForm(query.data.data); }, [query.data]);
  useEffect(() => { const value = googleQuery.data?.data; if (!value) return; setGoogleClientId(value.clientId ?? ''); setGoogleRedirectUri(value.redirectUri ?? productionGoogleRedirectUri); setGoogleProjectId(value.projectId ?? ''); }, [googleQuery.data]);
  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Loading executive settings…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const update = <K extends keyof CeoSettings>(key: K, value: CeoSettings[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true); setSaved(false); setError(null);
    try { await api('/ceo/settings', { method: 'PATCH', body: JSON.stringify(form) }); await queryClient.invalidateQueries({ queryKey: ['ceo-settings'] }); setSaved(true); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save executive settings.'); }
    finally { setSaving(false); }
  };
  const saveGoogle = async () => { setGoogleSaving(true); setGoogleSaved(false); setGoogleError(null); try { await api('/ceo/google-oauth', { method: 'PUT', body: JSON.stringify({ clientId: googleClientId, clientSecret: googleClientSecret || undefined, redirectUri: googleRedirectUri, projectId: googleProjectId || undefined }) }); setGoogleClientSecret(''); await googleQuery.refetch(); setGoogleSaved(true); } catch (problem) { setGoogleError(problem instanceof Error ? problem.message : 'Could not save Google OAuth configuration.'); } finally { setGoogleSaving(false); } };
  const clearGoogle = async () => { if (!window.confirm('Clear the CEO-managed Google OAuth client? Existing connected accounts will remain until disconnected.')) return; setGoogleSaving(true); setGoogleError(null); try { await api('/ceo/google-oauth', { method: 'DELETE' }); await googleQuery.refetch(); setGoogleClientId(''); setGoogleClientSecret(''); setGoogleRedirectUri(productionGoogleRedirectUri); setGoogleProjectId(''); setGoogleSaved(true); } catch (problem) { setGoogleError(problem instanceof Error ? problem.message : 'Could not clear Google OAuth configuration.'); } finally { setGoogleSaving(false); } };
  return <>
    <PageHeader eyebrow="EXECUTIVE GOVERNANCE" title="CEO settings" description="Configure approval thresholds, reporting preferences and the widgets shown on the command dashboard." actions={<button className="button button--secondary" onClick={() => navigate('/ceo-dashboard')}><ArrowLeft size={16} /> Dashboard</button>} />
    <section className="ceo-settings-layout">
      <article className="content-card ceo-settings-card"><div className="card-heading"><div><p className="eyebrow">APPROVAL RULES</p><h2>When CEO approval is required</h2></div><ShieldAlert size={20} /></div><p className="ceo-settings-intro">Thresholds are evaluated by workflow owners. Changing a threshold is itself recorded in the CEO audit log.</p><div className="ceo-settings-grid"><label className="field"><span>Expenses above (₹)</span><input type="number" min="0" value={form.expenseApprovalAbove} onChange={(event) => update('expenseApprovalAbove', Number(event.target.value))} /></label><label className="field"><span>Discounts above (%)</span><input type="number" min="0" max="100" value={form.discountApprovalAbove} onChange={(event) => update('discountApprovalAbove', Number(event.target.value))} /></label><label className="field"><span>Salary increments above (%)</span><input type="number" min="0" max="100" value={form.salaryIncrementApprovalAbove} onChange={(event) => update('salaryIncrementApprovalAbove', Number(event.target.value))} /></label><label className="field"><span>Department-head limit (₹)</span><input type="number" min="0" value={form.departmentHeadApprovalLimit} onChange={(event) => update('departmentHeadApprovalLimit', Number(event.target.value))} /></label></div><div className="ceo-toggle-list"><Toggle label="Project budget overruns require approval" checked={form.projectBudgetOverrunApproval} onChange={(value) => update('projectBudgetOverrunApproval', value)} /><Toggle label="Invoice cancellation requires approval" checked={form.invoiceCancellationApproval} onChange={(value) => update('invoiceCancellationApproval', value)} /><Toggle label="High-priority hiring requires approval" checked={form.highPriorityHiringApproval} onChange={(value) => update('highPriorityHiringApproval', value)} /></div></article>
      <article className="content-card ceo-settings-card"><div className="card-heading"><div><p className="eyebrow">REPORTING & PRIVACY</p><h2>Executive defaults</h2></div><LockKeyhole size={20} /></div><p className="ceo-settings-intro">These defaults affect only the CEO command experience. Secrets and authentication tokens are never returned here.</p><div className="ceo-settings-grid"><label className="field"><span>Financial year</span><input value={form.financialYear} onChange={(event) => update('financialYear', event.target.value)} placeholder="2026-27" /></label><label className="field"><span>Default report format</span><select value={form.defaultReportFormat} onChange={(event) => update('defaultReportFormat', event.target.value as CeoSettings['defaultReportFormat'])}><option value="pdf">PDF</option><option value="xlsx">Excel (XLSX)</option><option value="csv">CSV</option></select></label></div><div className="ceo-settings-notice"><Check size={16} /><span>Facts and forecasts are labelled separately. Clara must ask for confirmation before sensitive actions.</span></div></article>
      <article className="content-card ceo-settings-card ceo-google-oauth-card"><div className="card-heading"><div><p className="eyebrow">GOOGLE WORKSPACE</p><h2>Google OAuth client</h2></div><KeyRound size={20} /></div><p className="ceo-settings-intro">Configure the OAuth client used for Google Calendar, Google Meet and the CEO/Admin-owned Drive backup folder. The client secret is encrypted at rest, write-only, and never displayed.</p>{googleQuery.isPending ? <p className="muted-copy">Checking Google OAuth configuration…</p> : <><div className="integration-status-grid"><div><small>Status</small><strong>{googleQuery.data?.data.configured ? 'Configured' : 'Not configured'}</strong><span>{googleQuery.data?.data.source === 'settings' ? 'CEO settings' : googleQuery.data?.data.source === 'environment' ? 'Deployment environment' : 'Add a client below'}</span></div><div><small>Client ID</small><strong>{googleQuery.data?.data.clientId ?? '—'}</strong><span>{googleQuery.data?.data.storedClientSecret ? 'Encrypted secret saved' : 'Secret not saved'}</span></div><div><small>Redirect URI</small><strong>{googleQuery.data?.data.redirectUri ?? productionGoogleRedirectUri}</strong><span>Must exactly match Google Cloud Console</span></div></div><div className="ceo-settings-grid"><label className="field field--wide"><span>OAuth client ID *</span><input value={googleClientId} onChange={e=>setGoogleClientId(e.target.value)} placeholder="123…apps.googleusercontent.com" required /></label><label className="field field--wide"><span>OAuth client secret {googleQuery.data?.data.storedClientSecret ? '(leave blank to keep current)' : '*'}</span><input type="password" value={googleClientSecret} onChange={e=>setGoogleClientSecret(e.target.value)} placeholder={googleQuery.data?.data.storedClientSecret ? 'Stored securely' : 'Google client secret'} required={!googleQuery.data?.data.storedClientSecret} autoComplete="new-password" /></label><label className="field field--wide"><span>Authorized redirect URI *</span><input type="url" value={googleRedirectUri} onChange={e=>setGoogleRedirectUri(e.target.value)} placeholder={productionGoogleRedirectUri} required /></label><label className="field field--wide"><span>Google Cloud project ID</span><input value={googleProjectId} onChange={e=>setGoogleProjectId(e.target.value)} placeholder="Optional project ID" /></label></div><div className="integration-key-actions"><button className="button" type="button" disabled={googleSaving} onClick={()=>void saveGoogle()}><Save size={15}/>{googleSaving?'Saving…':'Save Google OAuth client'}</button>{googleQuery.data?.data.configured&&<button className="button button--secondary" type="button" disabled={googleSaving} onClick={()=>void clearGoogle()}>Clear saved client</button>}</div>{googleError&&<p className="form-error" role="alert">{googleError}</p>}{googleSaved&&<p className="form-success"><Check size={15}/> Google OAuth settings saved and audited.</p>}<p className="integration-note">Enable the Calendar, Meet and Drive APIs. Use this exact callback in Google Cloud Console → Google Auth Platform → Clients → Authorized redirect URIs: <code>{productionGoogleRedirectUri}</code>. Add the authorized Google account under Audience → Test users until the consent screen is published.</p></>}</article>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}{saved && <p className="form-success"><Check size={15} /> Executive settings saved and audited.</p>}<button className="button ceo-save-settings" type="button" disabled={saving} onClick={() => void save()}><Save size={16} /> {saving ? 'Saving…' : 'Save executive settings'}</button>
  </>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="ceo-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="ceo-toggle__track" aria-hidden="true"><span /></span><span>{label}</span></label>;
}

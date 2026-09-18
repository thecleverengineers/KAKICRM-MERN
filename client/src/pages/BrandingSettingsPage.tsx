import { useEffect, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ImagePlus, KeyRound, MessageCircle, Palette, RotateCcw, Save, Trash2, Upload } from 'lucide-react';
import { BrandVisual } from '../components/BrandVisual.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api } from '../lib/api.js';
import { defaultBranding, type Branding, useBranding } from '../lib/branding.js';
import { useAuth } from '../store/auth.js';

type BrandingFields = Pick<Branding, 'site_title' | 'site_subtitle' | 'logo_url' | 'logo_day_url' | 'logo_night_url' | 'legal_company_name' | 'company_information' | 'company_address' | 'company_phone' | 'company_email' | 'company_website' | 'invoice_logo_url' | 'invoice_footer' | 'invoice_accent'>;

export function BrandingSettingsPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const contextBranding = useBranding();
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: async () => (await api<{ data: Branding }>('/settings/branding')).data
  });
  const [fields, setFields] = useState<BrandingFields>(contextBranding);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'day' | 'night' | 'invoice' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setFields(query.data);
  }, [query.data]);

  if (!hasPermission('rbac.manage')) return <ErrorState message="Only administrators can change organisation branding." />;
  if (query.isPending) return <LoadingState label="Loading brand settings…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const update = <Key extends keyof BrandingFields>(key: Key, value: BrandingFields[Key]) => setFields((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await api<{ data: Branding }>('/settings/branding', { method: 'PATCH', body: JSON.stringify(fields) });
      setFields(response.data);
      queryClient.setQueryData(['branding'], response.data);
      setSuccess('Branding saved. The updated title and design are now live.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save branding.');
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>, kind: 'day' | 'night' | 'invoice') => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(kind);
    setError(null);
    setSuccess(null);
    try {
      const body = new FormData();
      body.append('logo', file);
      body.append('kind', kind);
      const response = await api<{ data: Branding }>('/settings/branding/logo', { method: 'POST', body });
      setFields(response.data);
      queryClient.setQueryData(['branding'], response.data);
      setSuccess(kind === 'invoice' ? 'Invoice logo uploaded.' : `${kind === 'day' ? 'Day' : 'Night'} mode logo uploaded.`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to upload the logo.');
    } finally {
      setUploading(null);
    }
  };

  const restore = () => {
    setFields(defaultBranding);
    setSuccess(null);
    setError(null);
  };

  return <>
    <PageHeader eyebrow="ADMINISTRATION" title="Site settings" description="Manage the site identity, day/night logos, legal company information, invoices, browser alerts and approved integrations." />
    <form className="branding-layout" onSubmit={(event) => void save(event)}>
      <section className="content-card branding-form-card">
        <div className="card-heading"><div><p className="eyebrow">SITE IDENTITY</p><h2>Brand and legal information</h2></div><Building2 size={22} aria-hidden="true" /></div>
        <div className="form-grid">
          <label className="field"><span>Site title *</span><input value={fields.site_title} maxLength={80} onChange={(event) => update('site_title', event.target.value)} required /></label>
          <label className="field"><span>Site subtitle</span><input value={fields.site_subtitle} maxLength={120} onChange={(event) => update('site_subtitle', event.target.value)} /></label>
          <label className="field field--wide"><span>Legal company name *</span><input value={fields.legal_company_name} maxLength={180} onChange={(event) => update('legal_company_name', event.target.value)} required /></label>
          <label className="field field--wide"><span>Company information</span><textarea value={fields.company_information} maxLength={2_000} rows={3} placeholder="Short legal or business description" onChange={(event) => update('company_information', event.target.value)} /></label>
          <label className="field field--wide"><span>Company address</span><textarea value={fields.company_address} maxLength={2_000} rows={3} placeholder="Registered or operating address" onChange={(event) => update('company_address', event.target.value)} /></label>
          <label className="field"><span>Company phone</span><input value={fields.company_phone} maxLength={80} onChange={(event) => update('company_phone', event.target.value)} /></label>
          <label className="field"><span>Company email</span><input type="email" value={fields.company_email} maxLength={180} onChange={(event) => update('company_email', event.target.value)} /></label>
          <label className="field field--wide"><span>Company website</span><input type="url" value={fields.company_website} maxLength={300} placeholder="https://example.com" onChange={(event) => update('company_website', event.target.value)} /></label>
          <label className="field field--wide"><span>Invoice footer</span><textarea value={fields.invoice_footer} maxLength={500} rows={3} onChange={(event) => update('invoice_footer', event.target.value)} /></label>
          <label className="field"><span>Invoice accent</span><span className="branding-colour-input"><input type="color" value={fields.invoice_accent} onChange={(event) => update('invoice_accent', event.target.value)} /><input value={fields.invoice_accent} maxLength={7} pattern="#[0-9a-fA-F]{6}" onChange={(event) => update('invoice_accent', event.target.value)} /></span></label>
        </div>
        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-success">{success}</p>}
        <div className="modal-actions branding-actions"><button type="button" className="button button--secondary" onClick={restore}><RotateCcw size={16} /> Restore defaults</button><button className="button" disabled={saving}>{saving ? 'Saving…' : <><Save size={16} /> Save branding</>}</button></div>
      </section>
      <aside className="branding-preview-stack">
        <section className="content-card branding-preview-card">
          <div className="card-heading"><div><p className="eyebrow">SITE LOGOS</p><h2>Day and night mode</h2><p className="muted-copy">Upload separate compact logos; each mode falls back safely to the other.</p></div><ImagePlus size={21} aria-hidden="true" /></div>
          <div className="branding-logo-mode-grid"><LogoModePreview label="Day mode" src={fields.logo_day_url ?? fields.logo_url} siteTitle={fields.site_title} /><LogoModePreview label="Night mode" src={fields.logo_night_url ?? fields.logo_day_url ?? fields.logo_url} siteTitle={fields.site_title} dark /></div>
          <div className="branding-logo-actions"><label className="button button--secondary button--full file-action"><Upload size={16} /> {uploading === 'day' ? 'Uploading…' : 'Upload day logo'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void uploadLogo(event, 'day')} disabled={uploading !== null} /></label><label className="button button--secondary button--full file-action"><Upload size={16} /> {uploading === 'night' ? 'Uploading…' : 'Upload night logo'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void uploadLogo(event, 'night')} disabled={uploading !== null} /></label></div>
          {(fields.logo_day_url || fields.logo_night_url || fields.logo_url) && <button type="button" className="text-button branding-reset-link" onClick={() => { update('logo_url', null); update('logo_day_url', null); update('logo_night_url', null); }}>Use initials instead</button>}
        </section>
        <section className="content-card branding-preview-card branding-invoice-preview-card" style={{ '--invoice-accent': fields.invoice_accent } as CSSProperties}>
          <div className="card-heading"><div><p className="eyebrow">INVOICE LOGO</p><h2>Invoice preview</h2></div><Palette size={21} aria-hidden="true" /></div>
          <div className="branding-invoice-mini"><div className="branding-invoice-mini-head"><div className="branding-site-preview"><BrandVisual src={fields.invoice_logo_url ?? fields.logo_day_url ?? fields.logo_url} label={fields.site_title} className="branding-invoice-logo" /><strong>{fields.site_title}</strong></div><span>INVOICE</span></div><div className="branding-mini-lines"><i /><i /><i /></div><strong className="branding-mini-total">₹ 0.00</strong><small>{fields.invoice_footer || defaultBranding.invoice_footer}</small></div>
          <label className="button button--secondary button--full file-action"><Upload size={16} /> {uploading === 'invoice' ? 'Uploading…' : 'Upload invoice logo'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void uploadLogo(event, 'invoice')} disabled={uploading !== null} /></label>
          {fields.invoice_logo_url && <button type="button" className="text-button branding-reset-link" onClick={() => update('invoice_logo_url', null)}>Use site logo on invoices</button>}
        </section>
      </aside>
    </form>
    <Fast2SmsWhatsAppSettings />
  </>;
}

function LogoModePreview({ label, src, siteTitle, dark = false }: { label: string; src: string | null; siteTitle: string; dark?: boolean }) {
  return <div className={`branding-logo-mode-preview${dark ? ' branding-logo-mode-preview--dark' : ''}`}><small>{label}</small><div className="branding-site-preview"><BrandVisual src={src} label={siteTitle} className="branding-site-logo" /><div><strong>{siteTitle}</strong><span>Operations hub</span></div></div></div>;
}

interface Fast2SmsWhatsAppStatus {
  configured: boolean;
  source: 'settings' | 'environment' | 'not_configured';
  storedCredential: boolean;
  templateName: string;
  messageId: string;
  phoneNumberId: string;
  senderNumber: string;
  apiUrl: string;
  updatedAt: string | null;
}

function Fast2SmsWhatsAppSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['fast2sms-whatsapp-settings'],
    queryFn: async () => (await api<{ data: Fast2SmsWhatsAppStatus }>('/settings/integrations/fast2sms-whatsapp')).data
  });
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim().length < 8) {
      setError('Enter your Fast2SMS authorization key.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api<{ data: Fast2SmsWhatsAppStatus }>('/settings/integrations/fast2sms-whatsapp', { method: 'PUT', body: JSON.stringify({ apiKey: apiKey.trim() }) });
      queryClient.setQueryData(['fast2sms-whatsapp-settings'], response.data);
      setApiKey('');
      setMessage('Fast2SMS authorization key saved securely. New task assignments will use it immediately.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save the Fast2SMS key.');
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setClearing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api<{ data: Fast2SmsWhatsAppStatus }>('/settings/integrations/fast2sms-whatsapp', { method: 'DELETE' });
      queryClient.setQueryData(['fast2sms-whatsapp-settings'], response.data);
      setMessage(response.data.configured ? 'Saved key removed. The server environment key remains active.' : 'Saved Fast2SMS key removed.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to remove the Fast2SMS key.');
    } finally {
      setClearing(false);
    }
  };

  return <section className="content-card integration-settings-card">
    <div className="card-heading"><div><p className="eyebrow">WHATSAPP INTEGRATION</p><h2>Fast2SMS task alerts</h2><p className="muted-copy">Administrator-only credential control for the approved <strong>my_task</strong> template.</p></div><MessageCircle size={21} /></div>
    {query.isPending ? <p className="muted-copy">Loading Fast2SMS status…</p> : query.isError ? <p className="form-error">{query.error.message}</p> : <>
      <div className="integration-status-grid"><div><small>Status</small><strong>{status?.configured ? 'Configured' : 'Not configured'}</strong><span>{status?.storedCredential ? 'Secure key saved in Settings' : status?.configured ? 'Using server environment key' : 'Save a Fast2SMS key to enable task alerts'}</span></div><div><small>Approved template</small><strong>{status?.templateName}</strong><span>Message ID {status?.messageId} · Sender {status?.senderNumber}</span></div><div><small>Phone Number ID</small><strong>{status?.phoneNumberId}</strong><span>Six variables · no media/document</span></div></div>
      <form className="integration-key-form" onSubmit={(event) => void saveKey(event)}><label className="field"><span>Fast2SMS authorization key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status?.configured ? 'Enter a new key to replace the saved key' : 'Paste Fast2SMS authorization key'} autoComplete="new-password" /></label><div className="integration-key-actions"><button className="button" type="submit" disabled={saving}><KeyRound size={16} /> {saving ? 'Saving…' : status?.storedCredential ? 'Replace key' : 'Save key'}</button>{status?.storedCredential && <button className="button button--secondary" type="button" onClick={() => void clearKey()} disabled={clearing || saving}><Trash2 size={16} /> {clearing ? 'Removing…' : 'Remove saved key'}</button>}</div></form>
      <p className="integration-note">The key is encrypted before it is stored and is never displayed again. This setting takes effect without restarting KAKI CRM.</p>
      {error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}
    </>}
  </section>;
}

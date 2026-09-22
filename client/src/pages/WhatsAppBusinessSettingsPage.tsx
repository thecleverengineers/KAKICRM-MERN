import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Link2, LockKeyhole, MessageCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

interface WhatsAppBusinessStatus {
  configured: boolean;
  connected: boolean;
  verifiedName: string | null;
  displayPhoneNumber: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
}

const MANAGER_ROLES = ['admin', 'administrator', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'ceo', 'chief_executive_officer', 'chief_executive'];

export function WhatsAppBusinessSettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const role = String(user?.role ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed = MANAGER_ROLES.includes(role);
  const [accessToken, setAccessToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['whatsapp-business-status'],
    enabled: allowed,
    queryFn: async () => (await api<{ data: WhatsAppBusinessStatus }>('/settings/integrations/whatsapp-business')).data
  });

  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Checking WhatsApp Business connection…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const status = query.data;
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await api<{ data: WhatsAppBusinessStatus }>('/settings/integrations/whatsapp-business', {
        method: 'PUT', body: JSON.stringify({ accessToken: accessToken.trim(), phoneNumberId: phoneNumberId.trim() })
      });
      setAccessToken(''); setPhoneNumberId('');
      queryClient.setQueryData(['whatsapp-business-status'], response.data);
      setMessage('WhatsApp Business account verified and connected. The credentials were encrypted on the server.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not connect the WhatsApp Business account.');
    } finally { setSaving(false); }
  };

  const verify = async () => {
    setVerifying(true); setError(null); setMessage(null);
    try {
      const response = await api<{ data: WhatsAppBusinessStatus }>('/settings/integrations/whatsapp-business/verify', { method: 'POST' });
      queryClient.setQueryData(['whatsapp-business-status'], response.data);
      setMessage('Meta verified the saved WhatsApp Business connection.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not verify the saved connection.');
    } finally { setVerifying(false); }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect the company WhatsApp Business account and remove its saved credentials?')) return;
    setDisconnecting(true); setError(null); setMessage(null);
    try {
      const response = await api<{ data: WhatsAppBusinessStatus }>('/settings/integrations/whatsapp-business', { method: 'DELETE' });
      queryClient.setQueryData(['whatsapp-business-status'], response.data);
      setMessage('WhatsApp Business disconnected and the stored credentials were removed.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not disconnect WhatsApp Business.');
    } finally { setDisconnecting(false); }
  };

  return <>
    <PageHeader eyebrow="COMPANY INTEGRATIONS" title="WhatsApp Business" description="Connect the company’s Meta WhatsApp Business number for CRM messaging integrations." />
    <section className="content-card whatsapp-business-card">
      <div className="card-heading"><div><p className="eyebrow">META CLOUD API</p><h2>Company account connection</h2><p className="muted-copy">Only admins, HR and the CEO can manage this company-wide connection.</p></div><MessageCircle size={22} /></div>
      <div className={`whatsapp-business-status${status.connected ? ' whatsapp-business-status--connected' : ''}`}>
        <span className="whatsapp-business-status__icon">{status.connected ? <Check size={18} /> : <Link2 size={18} />}</span>
        <div><strong>{status.connected ? 'Connected' : 'Not connected'}</strong><span>{status.connected ? [status.verifiedName, status.displayPhoneNumber].filter(Boolean).join(' · ') || 'Meta verified this business phone number' : 'Connect a registered WhatsApp Business Platform number.'}</span></div>
        {status.connected && <button className="button button--secondary" type="button" onClick={() => void verify()} disabled={verifying || saving || disconnecting}><RefreshCw size={15} /> {verifying ? 'Checking…' : 'Verify connection'}</button>}
      </div>
      <form className="whatsapp-business-form" onSubmit={(event) => void connect(event)}>
        <label className="field field--wide"><span>Meta system-user access token</span><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={status.configured ? 'Enter a new token to replace the saved token' : 'Paste the Meta access token'} autoComplete="new-password" required minLength={20} maxLength={4096} /></label>
        <label className="field field--wide"><span>WhatsApp Business phone number ID</span><input type="text" inputMode="numeric" value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value.replace(/\D/g, '').slice(0, 32))} placeholder={status.configured ? 'Enter the phone number ID again to replace credentials' : 'Numeric ID from Meta WhatsApp API Setup'} autoComplete="off" required minLength={5} maxLength={32} pattern="[0-9]{5,32}" /></label>
        <div className="whatsapp-business-actions"><button className="button" type="submit" disabled={saving || verifying || disconnecting}><KeyRound size={16} /> {saving ? 'Verifying and saving…' : status.configured ? 'Replace and connect' : 'Verify and connect'}</button>{status.configured && <button className="button button--secondary" type="button" onClick={() => void disconnect()} disabled={saving || verifying || disconnecting}><Trash2 size={16} /> {disconnecting ? 'Disconnecting…' : 'Disconnect'}</button>}</div>
      </form>
      <div className="whatsapp-business-security-note"><LockKeyhole size={16} /><p>The access token and phone number ID are encrypted and stored on the server. The browser receives only connection status and Meta’s verified display details; credentials are never returned or saved in browser storage.</p></div>
      <p className="integration-note">Use a Meta system-user token with WhatsApp Business permissions and the phone number ID for a registered Cloud API number. Connecting verifies the credentials with Meta before saving them.</p>
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    </section>
  </>;
}

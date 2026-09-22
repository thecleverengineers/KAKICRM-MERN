import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, KeyRound, LockKeyhole, Plus, Save, Share2, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { api, ApiError } from '../lib/api.js';

interface VaultCredential {
  id: string;
  ownerUserId: number;
  ownerName: string;
  isOwner: boolean;
  title: string;
  website: string;
  username: string;
  password: string;
  notes: string;
  sharedWith: Array<{ id: number; name: string; role: string }>;
  createdAt: string;
  updatedAt: string;
}

interface Recipient { id: number; name: string; email: string; role: string }
interface VaultStatus { configured: boolean }
interface Draft { id?: string; title: string; website: string; username: string; password: string; notes: string; sharedWithUserIds: number[] }

const emptyDraft = (): Draft => ({ title: '', website: '', username: '', password: '', notes: '', sharedWithUserIds: [] });
const apiWithVault = <T,>(path: string, token: string, init: RequestInit = {}) => api<T>(path, {
  ...init,
  headers: { ...Object.fromEntries(new Headers(init.headers).entries()), 'X-Credential-Vault-Session': token }
});

export function CredentialVaultPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [vaultSession, setVaultSession] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [pinPanelOpen, setPinPanelOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const status = useQuery({ queryKey: ['credential-vault-status'], queryFn: () => api<VaultStatus>('/credential-vault/status') });
  const credentials = useQuery({
    queryKey: ['credential-vault-credentials'],
    queryFn: () => apiWithVault<{ data: VaultCredential[] }>('/credential-vault/credentials', vaultSession!),
    enabled: Boolean(vaultSession), staleTime: 0
  });
  const recipients = useQuery({
    queryKey: ['credential-vault-recipients'],
    queryFn: () => apiWithVault<{ data: Recipient[] }>('/credential-vault/recipients', vaultSession!),
    enabled: Boolean(vaultSession), staleTime: 60_000
  });
  const orderedCredentials = useMemo(() => [...(credentials.data?.data ?? [])].sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.title.localeCompare(b.title)), [credentials.data]);

  useEffect(() => {
    if (!vaultSession) return undefined;
    const timer = window.setTimeout(() => {
      setVaultSession(null);
      setVisiblePasswords(new Set());
      setError('Your vault session expired. Enter your six-digit code to unlock it again.');
    }, 15 * 60_000);
    return () => window.clearTimeout(timer);
  }, [vaultSession]);

  useEffect(() => {
    if (vaultSession) return;
    queryClient.removeQueries({ queryKey: ['credential-vault-credentials'] });
    queryClient.removeQueries({ queryKey: ['credential-vault-recipients'] });
  }, [queryClient, vaultSession]);

  useEffect(() => () => {
    queryClient.removeQueries({ queryKey: ['credential-vault-credentials'] });
    queryClient.removeQueries({ queryKey: ['credential-vault-recipients'] });
  }, [queryClient]);

  useEffect(() => {
    if (credentials.error instanceof ApiError && credentials.error.status === 423) {
      setVaultSession(null);
      setVisiblePasswords(new Set());
      setError('Your vault session expired. Enter your six-digit code to unlock it again.');
    }
  }, [credentials.error]);

  const setupVault = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) { setError('Enter a six-digit code using numbers only.'); return; }
    if (pin !== confirmPin) { setError('The two codes do not match.'); return; }
    setBusy(true);
    try {
      await api('/credential-vault/setup', { method: 'POST', body: JSON.stringify({ pin }) });
      setPin(''); setConfirmPin(''); setNotice('Your code is set. Unlock the vault to continue.');
      await status.refetch();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not set your vault code.'); }
    finally { setBusy(false); }
  };

  const unlockVault = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      const result = await api<{ vaultSession: string }>('/credential-vault/unlock', { method: 'POST', body: JSON.stringify({ pin }) });
      setVaultSession(result.vaultSession); setPin(''); setVisiblePasswords(new Set());
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not unlock the vault.'); }
    finally { setBusy(false); }
  };

  const saveCredential = async (event: FormEvent) => {
    event.preventDefault(); if (!vaultSession || !draft) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { id, ...values } = draft;
      await apiWithVault(id ? `/credential-vault/credentials/${id}` : '/credential-vault/credentials', vaultSession, {
        method: id ? 'PATCH' : 'POST', body: JSON.stringify(values)
      });
      setDraft(null); setNotice(id ? 'Credential updated.' : 'Credential saved securely.');
      await queryClient.invalidateQueries({ queryKey: ['credential-vault-credentials'] });
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save this credential.'); }
    finally { setBusy(false); }
  };

  const deleteCredential = async (credential: VaultCredential) => {
    if (!vaultSession || !window.confirm(`Delete “${credential.title}” from your vault?`)) return;
    setBusy(true); setError('');
    try {
      await apiWithVault(`/credential-vault/credentials/${credential.id}`, vaultSession, { method: 'DELETE' });
      setNotice('Credential deleted.');
      await queryClient.invalidateQueries({ queryKey: ['credential-vault-credentials'] });
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not delete this credential.'); }
    finally { setBusy(false); }
  };

  const changePin = async (event: FormEvent) => {
    event.preventDefault(); if (!vaultSession) return;
    setError(''); setNotice('');
    if (!/^\d{6}$/.test(newPin)) { setError('Your new code must contain six numbers.'); return; }
    if (newPin !== confirmNewPin) { setError('The new codes do not match.'); return; }
    setBusy(true);
    try {
      const result = await apiWithVault<{ vaultSession: string }>('/credential-vault/change-pin', vaultSession, { method: 'POST', body: JSON.stringify({ currentPin, newPin }) });
      setVaultSession(result.vaultSession);
      setCurrentPin(''); setNewPin(''); setConfirmNewPin(''); setPinPanelOpen(false); setNotice('Your six-digit code has been changed.');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not change your code.'); }
    finally { setBusy(false); }
  };

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); setError(''); }
    catch { setError('Clipboard access is unavailable in this browser.'); }
  };

  if (status.isPending) return <LoadingState label="Opening your Credential Vault…" />;
  if (status.isError) return <ErrorState message={status.error.message} onRetry={() => void status.refetch()} />;
  const configured = status.data.configured;

  return <>
    <PageHeader eyebrow="PRIVATE WORKSPACE" title="Credential Vault" description="Keep work sign-ins protected, then share each credential only with the colleagues who need it." actions={vaultSession ? <div className="vault-header-actions"><button className="button button--secondary" type="button" onClick={() => setPinPanelOpen((open) => !open)}><KeyRound size={16} /> Change code</button><button className="button" type="button" onClick={() => { setVaultSession(null); setVisiblePasswords(new Set()); setDraft(null); setPinPanelOpen(false); setNotice('Vault locked.'); }}><LockKeyhole size={16} /> Lock vault</button></div> : undefined} />

    {!vaultSession ? <section className="vault-gate content-card">
      <div className="vault-gate-icon"><ShieldCheck size={26} /></div>
      <p className="eyebrow">PERSONAL SIX-DIGIT CODE</p>
      <h2>{configured ? 'Unlock your vault' : 'Set up your vault'}</h2>
      <p>{configured ? 'Enter your private code to view credentials saved for you and credentials shared with you.' : 'Choose a six-digit code. You will enter it each time you open this protected space.'}</p>
      <form className="vault-gate-form" onSubmit={(event) => void (configured ? unlockVault(event) : setupVault(event))}>
        <label className="field"><span>{configured ? 'Six-digit code' : 'Create six-digit code'}</span><input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="••••••" required autoFocus /></label>
        {!configured && <label className="field"><span>Confirm code</span><input value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="••••••" required /></label>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="vault-notice" role="status">{notice}</p>}
        <button className="button" type="submit" disabled={busy || pin.length !== 6 || (!configured && confirmPin.length !== 6)}><LockKeyhole size={16} /> {busy ? 'Please wait…' : configured ? 'Unlock Credential Vault' : 'Create secure code'}</button>
      </form>
    </section> : <>
      {(error || notice) && <div className={error ? 'vault-alert vault-alert--error' : 'vault-alert'} role={error ? 'alert' : 'status'}>{error || notice}<button type="button" aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}><X size={15} /></button></div>}

      {pinPanelOpen && <form className="vault-pin-panel content-card" onSubmit={(event) => void changePin(event)}><div className="card-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>Change your vault code</h2></div><button type="button" className="icon-button" aria-label="Close code settings" onClick={() => setPinPanelOpen(false)}><X size={17} /></button></div><div className="vault-pin-grid"><label className="field"><span>Current code</span><input type="password" inputMode="numeric" maxLength={6} value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label><label className="field"><span>New six-digit code</span><input type="password" inputMode="numeric" maxLength={6} value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label><label className="field"><span>Confirm new code</span><input type="password" inputMode="numeric" maxLength={6} value={confirmNewPin} onChange={(event) => setConfirmNewPin(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label></div><button className="button" type="submit" disabled={busy}><Save size={16} /> Save new code</button></form>}

      {credentials.isPending ? <LoadingState label="Loading your protected credentials…" /> : credentials.isError ? <ErrorState message={credentials.error.message} onRetry={() => void credentials.refetch()} /> : <>
        <section className="vault-overview-grid"><article className="vault-overview-card content-card"><span className="vault-overview-icon"><KeyRound size={18} /></span><div><strong>{orderedCredentials.length}</strong><span>credentials available</span></div></article><article className="vault-overview-card content-card"><span className="vault-overview-icon vault-overview-icon--shared"><Share2 size={18} /></span><div><strong>{orderedCredentials.filter((credential) => !credential.isOwner).length}</strong><span>shared with you</span></div></article><article className="vault-overview-card content-card"><span className="vault-overview-icon vault-overview-icon--owned"><UserRound size={18} /></span><div><strong>{orderedCredentials.filter((credential) => credential.isOwner).length}</strong><span>owned by you</span></div></article></section>

        <section className="vault-list content-card"><div className="card-heading"><div><p className="eyebrow">YOUR SECURE SIGN-INS</p><h2>Credentials</h2><p className="muted-copy">Only the owner can edit or delete a credential. Shared credentials are read-only for recipients.</p></div><button className="button" type="button" onClick={() => { setError(''); setDraft(emptyDraft()); }}><Plus size={16} /> Add credential</button></div>
          {!orderedCredentials.length ? <div className="vault-empty"><KeyRound size={27} /><strong>No credentials yet</strong><span>Save a work login and choose exactly who can access it.</span><button className="button button--secondary" type="button" onClick={() => setDraft(emptyDraft())}><Plus size={15} /> Add your first credential</button></div> : <div className="vault-credential-grid">{orderedCredentials.map((credential) => <article className="vault-credential-card" key={credential.id}>
            <div className="vault-credential-head"><span className="vault-credential-mark"><KeyRound size={17} /></span><div><h3>{credential.title}</h3><span>{credential.website || 'Website or app sign-in'}</span></div>{credential.isOwner ? <span className="vault-owner-badge">Owned by you</span> : <span className="vault-owner-badge vault-owner-badge--shared">Shared with you</span>}</div>
            <div className="vault-secret-row"><span>Username</span><strong>{credential.username || '—'}</strong>{credential.username && <button className="icon-button" type="button" onClick={() => void copy(credential.username, 'Username')} aria-label="Copy username"><Copy size={15} /></button>}</div>
            <div className="vault-secret-row"><span>Password</span><strong className="vault-password-value">{visiblePasswords.has(credential.id) ? credential.password : '••••••••••••'}</strong><button className="icon-button" type="button" onClick={() => setVisiblePasswords((current) => { const next = new Set(current); next.has(credential.id) ? next.delete(credential.id) : next.add(credential.id); return next; })} aria-label={visiblePasswords.has(credential.id) ? 'Hide password' : 'Show password'}>{visiblePasswords.has(credential.id) ? <EyeOff size={15} /> : <Eye size={15} />}</button><button className="icon-button" type="button" onClick={() => void copy(credential.password, 'Password')} aria-label="Copy password"><Copy size={15} /></button></div>
            {credential.notes && <p className="vault-credential-notes">{credential.notes}</p>}
            <div className="vault-sharing-summary"><Share2 size={14} /><span>{credential.isOwner ? credential.sharedWith.length ? `Shared with ${credential.sharedWith.map((person) => person.name).join(', ')}` : 'Only you can access this credential' : `Shared by ${credential.ownerName}`}</span></div>
            {credential.isOwner && <div className="vault-card-actions"><button type="button" className="text-button" onClick={() => { setError(''); setDraft({ id: credential.id, title: credential.title, website: credential.website, username: credential.username, password: credential.password, notes: credential.notes, sharedWithUserIds: credential.sharedWith.map((person) => person.id) }); }}><Share2 size={15} /> Edit and manage sharing</button><button className="icon-button vault-delete-button" type="button" disabled={busy} aria-label={`Delete ${credential.title}`} onClick={() => void deleteCredential(credential)}><Trash2 size={16} /></button></div>}
          </article>)}</div>}
        </section>
      </>}
    </>}

    {draft && <div className="vault-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}><section className="vault-dialog content-card" role="dialog" aria-modal="true" aria-labelledby="vault-dialog-title"><div className="card-heading"><div><p className="eyebrow">ENCRYPTED AT REST</p><h2 id="vault-dialog-title">{draft.id ? 'Manage credential' : 'Add credential'}</h2></div><button type="button" className="icon-button" aria-label="Close credential form" onClick={() => setDraft(null)}><X size={17} /></button></div><form onSubmit={(event) => void saveCredential(event)}><div className="vault-form-grid"><label className="field"><span>Credential name</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="For example, CRM admin" required maxLength={160} /></label><label className="field"><span>Website or app</span><input value={draft.website} onChange={(event) => setDraft({ ...draft, website: event.target.value })} placeholder="https://example.com" maxLength={500} /></label><label className="field"><span>Username or email</span><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} autoComplete="off" maxLength={500} /></label><label className="field"><span>Password</span><input value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} autoComplete="new-password" required maxLength={2_000} /></label><label className="field vault-form-notes"><span>Private notes</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={3} maxLength={10_000} /></label></div>
        <div className="vault-share-picker"><div><strong>Share with selected colleagues</strong><span>They can unlock their own vault and view this credential. You can remove access at any time.</span></div>{recipients.isPending ? <span className="muted-copy">Loading staff…</span> : recipients.isError ? <span className="form-error">{recipients.error.message}</span> : <div className="vault-recipient-list">{recipients.data?.data.map((person) => <label className="vault-recipient" key={person.id}><input type="checkbox" checked={draft.sharedWithUserIds.includes(person.id)} onChange={(event) => setDraft({ ...draft, sharedWithUserIds: event.target.checked ? [...draft.sharedWithUserIds, person.id] : draft.sharedWithUserIds.filter((id) => id !== person.id) })} /><span><strong>{person.name}</strong><small>{person.role.replaceAll('_', ' ')}{person.email ? ` · ${person.email}` : ''}</small></span><Check size={15} /></label>)}</div>}</div>
        {error && <p className="form-error" role="alert">{error}</p>}<footer className="vault-dialog-actions"><button type="button" className="button button--secondary" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="button" disabled={busy || recipients.isPending}><Save size={16} /> {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save credential'}</button></footer>
      </form></section></div>}
  </>;
}

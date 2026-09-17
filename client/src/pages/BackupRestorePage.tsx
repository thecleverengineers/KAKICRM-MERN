import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArchiveRestore, CheckCircle2, Cloud, DatabaseBackup, Download, ExternalLink, FolderPlus, HardDrive, Link2, LockKeyhole, RefreshCw, ShieldCheck, Unplug, Upload } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, apiUrl, getAccessToken } from '../lib/api.js';
import { isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

interface BackupItem { id: string; filename: string; createdAt: string; size: number; trigger: string; sha256: string | null; cloud: 'uploaded' | 'pending' | 'failed' | 'not_configured' | 'unknown'; verifiedAt: string | null }
interface BackupState { operation: string; status: string; startedAt?: string; finishedAt?: string; message?: string; backupId?: string }
interface BackupSystem { schedule: string; timezone: string; encryption: string; serverRoot: string; localRetention: number; driveRetentionDays: number; driveMode: string; localComputerCopy: string; included: string[]; excluded: string[] }
interface BackupGoogleDrive { oauthConfigured: boolean; googleConnected: boolean; hasDriveScope: boolean; connected: boolean; accountEmail: string | null; ownerUserId: number | null; folderId: string | null; folderName: string | null; folderUrl: string | null; connectedAt: string | null; lastTestedAt: string | null; lastSuccessAt: string | null; lastFileName: string | null; lastError: string | null }
interface BackupResponse { data: BackupItem[]; state: BackupState; system: BackupSystem; googleDrive: BackupGoogleDrive }

export function BackupRestorePage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupResponse>('/backups'), refetchInterval: 8_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [folderName, setFolderName] = useState('KAKI CRM Backups');
  const [folderReference, setFolderReference] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.data?.state.status === 'success' || query.data?.state.status === 'failed') setBusy(null);
  }, [query.data?.state.status]);

  useEffect(() => {
    const google = searchParams.get('google');
    if (!google) return;
    if (google === 'connected') setNotice('Google account connected. Create the dedicated backup folder below.');
    else setError('Google authorization was not completed. Confirm the account is an OAuth test user or publish the consent screen, then try again.');
    setSearchParams({}, { replace: true });
    void query.refetch();
  }, [query, searchParams, setSearchParams]);

  const role = user?.role.toLowerCase() ?? '';
  if (!['admin', 'administrator'].includes(role) && !isCeoRole(user?.role)) return <ErrorState message="Only the CEO or a system administrator can access Backup & Restore." />;
  if (query.isPending) return <LoadingState label="Loading disaster-recovery controls…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const payload = query.data!;

  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key); setError(null); setNotice(null);
    try {
      const result = await api<{ message: string }>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setNotice(result.message); setRestoreTarget(null); setConfirmation(''); await query.refetch();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Operation failed.'); setBusy(null); }
  };

  const connectGoogle = async () => {
    setBusy('google-connect'); setError(null);
    try { const result = await api<{ url: string }>('/backups/google/connect'); window.location.assign(result.url); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Google connection could not start.'); setBusy(null); }
  };

  const configureFolder = async (mode: 'create' | 'connect') => {
    const value = mode === 'create' ? folderName.trim() : folderReference.trim();
    if (!value) { setError(mode === 'create' ? 'Enter a folder name.' : 'Paste a Google Drive folder URL or folder ID.'); return; }
    setBusy(`google-${mode}`); setError(null); setNotice(null);
    try {
      const result = await api<{ message: string }>(mode === 'create' ? '/backups/google/folders' : '/backups/google/folder', {
        method: mode === 'create' ? 'POST' : 'PUT', body: JSON.stringify(mode === 'create' ? { name: value } : { folder: value })
      });
      setNotice(result.message); setFolderReference(''); await query.refetch();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Google Drive folder could not be connected.'); }
    finally { setBusy(null); }
  };

  const disconnectDrive = async () => {
    setBusy('google-disconnect'); setError(null); setNotice(null);
    try { const result = await api<{ message: string }>('/backups/google', { method: 'DELETE' }); setNotice(result.message); await query.refetch(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Google Drive folder could not be disconnected.'); }
    finally { setBusy(null); }
  };

  const uploadBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy('import'); setError(null); setNotice(null);
    try { const data = new FormData(); data.append('backup', file); const result = await api<{ message: string }>('/backups/import', { method: 'POST', body: data }); setNotice(result.message); await query.refetch(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Import failed.'); } finally { setBusy(null); }
  };

  const download = async (item: BackupItem) => {
    setBusy(`download:${item.id}`); setError(null);
    try {
      const response = await fetch(apiUrl(`/backups/${encodeURIComponent(item.id)}/download`), { headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` } });
      if (!response.ok) throw new Error('Unable to download this backup.');
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.filename; anchor.click(); URL.revokeObjectURL(url);
      setNotice('Encrypted local-computer copy downloaded. Keep its encryption key separately.');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Download failed.'); } finally { setBusy(null); }
  };

  const drive = payload.googleDrive;
  return <>
    <PageHeader eyebrow="DISASTER RECOVERY" title="Backup & Restore Control Centre" description="One encrypted recovery package for the complete CRM—database, source, configuration, uploads, documents and media." />
    <section className="backup-hero">
      <div><span className="backup-hero__icon"><ShieldCheck size={30} /></span><p className="eyebrow">3-COPY PROTECTION</p><h2>Server + Google Drive + your computer</h2><p>Automatic server and Drive copies run every day. Download any encrypted archive for the third offline copy.</p></div>
      <div className="backup-actions"><button className="button" disabled={Boolean(busy) || payload.state.status === 'running'} onClick={() => void run('create', '/backups')}><DatabaseBackup size={17} /> {busy === 'create' ? 'Starting…' : 'Create full backup'}</button><button className="button button--secondary" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}><Upload size={17} /> Import backup</button><input ref={fileInput} type="file" accept=".gpg,.tar.gz.gpg" hidden onChange={(event) => void uploadBackup(event)} /></div>
    </section>
    {(notice || error) && <div className={error ? 'backup-alert backup-alert--error' : 'backup-alert'}>{error ?? notice}</div>}
    <section className="backup-status-grid">
      <StatusCard icon={<RefreshCw size={21} />} title="Automatic schedule" value={`${payload.system.schedule} IST`} detail={payload.system.timezone} />
      <StatusCard icon={<LockKeyhole size={21} />} title="Encryption" value="AES-256 encrypted" detail="Secrets never leave the protected archive" />
      <StatusCard icon={<HardDrive size={21} />} title="Server vault" value={`${payload.system.localRetention} recovery points`} detail="Permission-protected local retention" />
      <StatusCard icon={<Cloud size={21} />} title="Google Drive" value={drive.connected ? 'Connected' : drive.googleConnected ? 'Choose folder' : 'Setup required'} detail={drive.connected ? `${drive.folderName} · ${payload.system.driveRetentionDays}-day retention` : 'CEO/Admin-owned Drive folder'} warning={!drive.connected} />
    </section>
    <DriveSetup drive={drive} busy={busy} folderName={folderName} folderReference={folderReference} onFolderName={setFolderName} onFolderReference={setFolderReference} onConnectGoogle={() => void connectGoogle()} onCreateFolder={() => void configureFolder('create')} onConnectFolder={() => void configureFolder('connect')} onTest={() => void run('google-test', '/backups/google/test')} onDisconnect={() => void disconnectDrive()} />
    {payload.state.status !== 'idle' && <section className={`backup-operation backup-operation--${payload.state.status}`}><strong>{payload.state.operation.toUpperCase()} · {payload.state.status}</strong><span>{payload.state.message ?? 'Operation is running in the secure server vault.'}</span></section>}
    <section className="content-card backup-scope"><div><p className="eyebrow">RECOVERY SCOPE</p><h2>Included in every full backup</h2></div><ul>{payload.system.included.map((item) => <li key={item}><CheckCircle2 size={16} /> {item}</li>)}</ul></section>
    <section className="content-card backup-list-card">
      <div className="card-heading"><div><p className="eyebrow">RECOVERY POINTS</p><h2>Encrypted backup vault</h2></div><button className="icon-button" onClick={() => void query.refetch()} aria-label="Refresh backups"><RefreshCw size={18} /></button></div>
      {!payload.data.length ? <p className="empty-state">No recovery point exists yet. Create the first full backup now.</p> : <div className="backup-list">{payload.data.map((item) => <article className="backup-row" key={item.id}>
        <div className="backup-row__badge"><DatabaseBackup size={21} /></div><div className="backup-row__main"><strong>{formatDate(item.createdAt)}</strong><span>{formatBytes(item.size)} · {item.trigger} · Drive: {cloudLabel(item.cloud)}</span><small>{item.sha256 ? `SHA-256 ${item.sha256.slice(0, 18)}…` : 'Checksum pending'}{item.verifiedAt ? ` · Verified ${formatDate(item.verifiedAt)}` : ''}</small></div>
        <div className="backup-row__actions"><button className="button button--secondary button--small" disabled={Boolean(busy)} onClick={() => void download(item)}><Download size={15} /> Download</button><button className="button button--secondary button--small" disabled={Boolean(busy)} onClick={() => void run(`verify:${item.id}`, `/backups/${encodeURIComponent(item.id)}/verify`)}><ShieldCheck size={15} /> Verify</button><button className="button button--danger button--small" disabled={Boolean(busy)} onClick={() => { setRestoreTarget(item); setConfirmation(''); }}><ArchiveRestore size={15} /> Restore</button></div>
      </article>)}</div>}
    </section>
    {restoreTarget && <div className="backup-modal" role="dialog" aria-modal="true"><div className="backup-modal__card"><span className="backup-modal__danger"><ArchiveRestore size={25} /></span><p className="eyebrow">DESTRUCTIVE RECOVERY</p><h2>Restore complete system?</h2><p>A pre-restore safety backup is created first. The CRM restarts while database, source, configuration and uploads return to this recovery point.</p><label className="field"><span>Type exactly: <strong>RESTORE {restoreTarget.id}</strong></span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><div className="dialog-actions"><button className="button button--secondary" onClick={() => setRestoreTarget(null)}>Cancel</button><button className="button button--danger" disabled={confirmation !== `RESTORE ${restoreTarget.id}` || Boolean(busy)} onClick={() => void run(`restore:${restoreTarget.id}`, `/backups/${encodeURIComponent(restoreTarget.id)}/restore`, { confirmation })}>Restore and restart</button></div></div></div>}
  </>;
}

function DriveSetup({ drive, busy, folderName, folderReference, onFolderName, onFolderReference, onConnectGoogle, onCreateFolder, onConnectFolder, onTest, onDisconnect }: { drive: BackupGoogleDrive; busy: string | null; folderName: string; folderReference: string; onFolderName: (value: string) => void; onFolderReference: (value: string) => void; onConnectGoogle: () => void; onCreateFolder: () => void; onConnectFolder: () => void; onTest: () => void; onDisconnect: () => void }) {
  return <section className="content-card backup-drive-card">
    <div className="backup-drive-card__heading"><div><p className="eyebrow">CEO/ADMIN GOOGLE DRIVE</p><h2>{drive.connected ? 'Cloud backup destination ready' : 'Connect a dedicated backup folder'}</h2><p>The selected account grants only app-created/app-authorized file access. Refresh tokens are encrypted, allowing unattended daily backups.</p></div><span className={drive.connected ? 'backup-drive-state backup-drive-state--ready' : 'backup-drive-state'}>{drive.connected ? <><CheckCircle2 size={16} /> Connected</> : <><Cloud size={16} /> Action required</>}</span></div>
    {!drive.oauthConfigured ? <div className="backup-drive-callout">Configure the Google OAuth web client in <a href="/ceo/settings">CEO Settings</a>, enable the Google Drive API, and return here.</div>
      : !drive.googleConnected || !drive.hasDriveScope ? <div className="backup-drive-actions"><div><strong>1. Authorize the CEO/Admin Google account</strong><p>Google asks for identity and limited Drive-file permission. The background job never receives the account password.</p></div><button className="button" disabled={Boolean(busy)} onClick={onConnectGoogle}><Link2 size={16} /> {busy === 'google-connect' ? 'Opening Google…' : 'Connect Google Drive'}</button></div>
        : !drive.connected ? <div className="backup-drive-choices">
          <div><strong>2. Create the recommended dedicated folder</strong><p>The CRM creates it in the connected user’s My Drive and immediately binds scheduled backups to it.</p><div className="backup-drive-input"><input value={folderName} maxLength={120} onChange={(event) => onFolderName(event.target.value)} placeholder="KAKI CRM Backups" /><button className="button" disabled={Boolean(busy)} onClick={onCreateFolder}><FolderPlus size={16} /> Create & connect</button></div></div>
          <div><strong>Or reconnect an app-authorized folder</strong><p>Paste a folder URL/ID previously created or authorized by this CRM OAuth client.</p><div className="backup-drive-input"><input value={folderReference} onChange={(event) => onFolderReference(event.target.value)} placeholder="https://drive.google.com/drive/folders/…" /><button className="button button--secondary" disabled={Boolean(busy)} onClick={onConnectFolder}>Connect folder</button></div></div>
        </div> : <div className="backup-drive-connected"><div><small>Google account</small><strong>{drive.accountEmail ?? 'Connected account'}</strong></div><div><small>Backup folder</small><strong>{drive.folderUrl ? <a href={drive.folderUrl} target="_blank" rel="noreferrer">{drive.folderName ?? 'Open folder'} <ExternalLink size={14} /></a> : drive.folderName}</strong></div><div><small>Last Drive backup</small><strong>{drive.lastSuccessAt ? formatDate(drive.lastSuccessAt) : 'Waiting for first backup'}</strong>{drive.lastFileName && <span>{drive.lastFileName}</span>}</div><div className="backup-drive-connected__actions"><button className="button button--secondary" disabled={Boolean(busy)} onClick={onTest}><ShieldCheck size={15} /> Test write access</button><button className="button button--secondary" disabled={Boolean(busy)} onClick={onDisconnect}><Unplug size={15} /> Disconnect folder</button></div></div>}
    {drive.lastError && <p className="form-error backup-drive-error">Last Google Drive error: {drive.lastError}</p>}
  </section>;
}

function StatusCard({ icon, title, value, detail, warning = false }: { icon: ReactNode; title: string; value: string; detail: string; warning?: boolean }) { return <article className={`backup-status-card${warning ? ' backup-status-card--warning' : ''}`}><span>{icon}</span><div><small>{title}</small><strong>{value}</strong><p>{detail}</p></div></article>; }
function cloudLabel(value: BackupItem['cloud']) { return value === 'not_configured' ? 'folder not configured' : value.replace('_', ' '); }
function formatBytes(value: number) { if (!value) return '0 B'; const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4); return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value)); }

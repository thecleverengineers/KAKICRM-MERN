import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, ChevronLeft, ChevronRight, ExternalLink, Plus, RefreshCw, ShieldCheck, UsersRound, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { SearchAutocomplete, useDebouncedValue } from '../components/SearchAutocomplete.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { dateTime } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface IntegrationStatus { connected: boolean; configured: boolean; email: string | null; connectedAt: string | null; scopes: string[]; requiredScopes: string[]; lastError: string | null }
interface GoogleServiceProbe { ok: boolean; message: string | null; httpStatus: number | null }
interface IntegrationCheck { ready: boolean; accountEmail: string | null; scopes: string[]; missingScopes: string[]; calendar: GoogleServiceProbe; meet: GoogleServiceProbe; message: string | null }

export function MeetingsPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const suggestionSearch = useDebouncedValue(searchInput.trim());
  const [status, setStatus] = useState('scheduled');
  const [page, setPage] = useState(1);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState<string | null>(null);
  const [checkingGoogle, setCheckingGoogle] = useState(false);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const role = String(user?.role ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const canManage = Boolean(hasPermission('meetings.create') || ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'ceo', 'chief_executive_officer', 'chief_executive'].includes(role));
  const canIntegrate = Boolean(hasPermission('meetings.manageIntegrations') || canManage);
  const query = useQuery({
    queryKey: ['meetings', page, search, status],
    queryFn: () => api<Paginated<PublicRecord>>(`/meetings${queryString({ page, limit: 10, search, status: status === 'all' ? undefined : status })}`)
  });
  const suggestionsQuery = useQuery({
    queryKey: ['meeting-search-suggestions', suggestionSearch, status],
    enabled: suggestionSearch.length > 0 && suggestionSearch === searchInput.trim(),
    staleTime: 30_000,
    queryFn: () => api<Paginated<PublicRecord>>(`/meetings${queryString({ page: 1, limit: 6, search: suggestionSearch, status: status === 'all' ? undefined : status })}`)
  });
  const integration = useQuery({ queryKey: ['google-integration'], enabled: canIntegrate, queryFn: () => api<{ data: IntegrationStatus }>('/integrations/google/status') });
  const users = useQuery({ queryKey: ['meeting-invitee-users'], enabled: scheduleOpen && canManage, queryFn: () => api<Paginated<PublicRecord>>('/records/users?limit=200&sort=name&order=asc') });
  const clients = useQuery({ queryKey: ['meeting-invitee-clients'], enabled: scheduleOpen && canManage, queryFn: () => api<Paginated<PublicRecord>>('/records/clients?limit=200&sort=name&order=asc') });
  const connectedMessage = searchParams.get('google') === 'connected';
  const googleError = searchParams.get('google') === 'error' ? searchParams.get('reason') : null;

  const connectGoogle = async () => {
    setError(null);
    setConnectingGoogle(true);
    try {
      const result = await api<{ url: string }>('/integrations/google/connect');
      window.location.assign(result.url);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Google Calendar could not be connected.');
      setConnectingGoogle(false);
    }
  };
  const reconnectGoogle = async () => {
    setError(null);
    setIntegrationNotice(null);
    setConnectingGoogle(true);
    try {
      await api('/integrations/google/disconnect', { method: 'DELETE' });
      await integration.refetch();
      const result = await api<{ url: string }>('/integrations/google/connect');
      window.location.assign(result.url);
    } catch (problem) {
      setConnectingGoogle(false);
      setError(problem instanceof Error ? problem.message : 'Google Calendar could not be reconnected.');
    }
  };
  const disconnectGoogle = async () => {
    if (!window.confirm('Disconnect this Google Calendar integration? Existing meetings remain in the CRM.')) return;
    try { await api('/integrations/google/disconnect', { method: 'DELETE' }); await integration.refetch(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Google Calendar could not be disconnected.'); }
  };
  const checkGoogle = async () => {
    setCheckingGoogle(true);
    setError(null);
    setIntegrationNotice(null);
    try {
      const result = await api<{ data: IntegrationCheck }>('/integrations/google/check');
      if (!result.data.ready) {
        setError(result.data.message || 'Google Calendar and Meet are not ready.');
        return;
      }
      setIntegrationNotice(`Google Calendar and Meet are ready${result.data.accountEmail ? ` for ${result.data.accountEmail}` : ''}.`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Google Calendar could not be checked.');
    } finally {
      setCheckingGoogle(false);
    }
  };
  const invalidate = async () => { await queryClient.invalidateQueries({ queryKey: ['meetings'] }); await queryClient.invalidateQueries({ queryKey: ['ceo-summary'] }); };

  if (query.isPending) return <LoadingState label="Loading meetings…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const result = query.data;
  return <>
    <PageHeader eyebrow="COLLABORATION" title="Meetings" description="Schedule Google Meet sessions, invite CRM staff, and retain consent-aware attendance records." actions={canManage ? <button className="button" type="button" onClick={() => setScheduleOpen(true)}><Plus size={17} /> Schedule meeting</button> : undefined} />
    {connectedMessage && <div className="meeting-banner meeting-banner--success"><Check size={17} /> Google Calendar is connected. You can now schedule a Meet.</div>}
    {googleError && <div className="meeting-banner meeting-banner--error"><X size={17} /><div><strong>Google connection was not completed.</strong><span>{googleError === 'access_denied' ? 'Google denied this account. In Google Cloud Console, add this account under Google Auth Platform → Audience → Test users while the app is in Testing (or publish it after verification), then use Reconnect Google. Also confirm the exact production callback URI.' : `Google returned ${googleError}. Check the OAuth client, consent screen, and redirect URI, then use Reconnect Google.`}</span></div></div>}
    {integrationNotice && <p className="meeting-inline-success" role="status">{integrationNotice}</p>}
    {error && <p className="form-error meeting-inline-error" role="alert">{error}</p>}
    {canIntegrate && <IntegrationCard status={integration.data?.data} loading={integration.isPending} checking={checkingGoogle} connecting={connectingGoogle} onConnect={() => void connectGoogle()} onReconnect={() => void reconnectGoogle()} onCheck={() => void checkGoogle()} onDisconnect={() => void disconnectGoogle()} />}
    <div className="meeting-toolbar content-card"><SearchAutocomplete
      className="search-autocomplete--meeting"
      value={searchInput}
      onChange={setSearchInput}
      onSubmit={() => { setSearch(searchInput.trim()); setPage(1); }}
      suggestions={suggestionsQuery.data?.data ?? []}
      getKey={(meeting) => meeting.id}
      getLabel={(meeting) => String(meeting.fields.title ?? meeting.fields.name ?? 'Untitled meeting')}
      getDetail={(meeting) => [meeting.fields.status ? String(meeting.fields.status).replaceAll('_', ' ') : '', meeting.fields.scheduled_start ? dateTime(meeting.fields.scheduled_start) : ''].filter(Boolean).join(' · ')}
      onSelect={(meeting) => { if (meeting.legacyId) navigate(`/data/meetings/${meeting.legacyId}`); }}
      loading={searchInput.trim().length > 0 && (suggestionSearch !== searchInput.trim() || suggestionsQuery.isFetching || suggestionsQuery.isPending)}
      error={suggestionsQuery.isError}
      placeholder="Search meetings…"
    /><label className="field meeting-status-filter"><span>Show</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="scheduled">Scheduled</option><option value="creating">Creating</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="failed">Failed</option><option value="all">All meetings</option></select></label><span className="meeting-count">{result.pagination.total} record{result.pagination.total === 1 ? '' : 's'}</span></div>
    <section className="meeting-list" aria-label="Meetings list">
      {result.data.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} onOpen={() => navigate(`/data/meetings/${meeting.legacyId}`)} />)}
      {!result.data.length && <div className="content-card meeting-empty"><CalendarClock size={28} /><strong>No meetings found</strong><span>Schedule a meeting after connecting an authorised Google Calendar account.</span></div>}
    </section>
    {result.pagination.pages > 1 && <div className="pagination meeting-pagination"><span>Page {result.pagination.page} of {result.pagination.pages}</span><div><button className="icon-button icon-button--small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="icon-button icon-button--small" disabled={page >= result.pagination.pages} onClick={() => setPage((current) => current + 1)} aria-label="Next page"><ChevronRight size={17} /></button></div></div>}
    {scheduleOpen && <ScheduleMeetingDialog users={users.data?.data ?? []} usersLoading={users.isPending} clients={clients.data?.data ?? []} clientsLoading={clients.isPending} onClose={() => setScheduleOpen(false)} onCreated={async () => { await invalidate(); setScheduleOpen(false); }} />}
  </>;
}

function IntegrationCard({ status, loading, checking, connecting, onConnect, onReconnect, onCheck, onDisconnect }: { status?: IntegrationStatus; loading: boolean; checking: boolean; connecting: boolean; onConnect: () => void; onReconnect: () => void; onCheck: () => void; onDisconnect: () => void }) {
  const missingScopes = status?.requiredScopes?.filter((scope) => !status.scopes.includes(scope)) ?? [];
  return <section className="content-card meeting-integration"><div className="meeting-integration__icon"><ShieldCheck size={20} /></div><div className="meeting-integration__copy"><p className="eyebrow">GOOGLE CALENDAR & MEET</p><strong>{loading ? 'Checking connection…' : status?.connected ? `Connected${status.email ? ` · ${status.email}` : ''}` : 'Connect an authorised Google account'}</strong><span>{status?.connected ? 'Calendar invitations and Meet links are created through Google. Tokens stay encrypted on the server.' : status?.configured === false ? 'An administrator must configure the Google OAuth client before connection is available.' : 'The connection requests Calendar events and Meet conference permissions.'}</span>{status?.connected && missingScopes.length > 0 && <small className="form-error">This connection is missing a required permission. Reconnect and approve both Calendar and Meet.</small>}{status?.lastError && <small className="form-error">{status.lastError}</small>}</div><div className="meeting-integration__actions">{status?.connected ? <><button className="button" type="button" disabled={checking || connecting} onClick={onReconnect}>{connecting ? 'Reconnecting…' : 'Reconnect Google'}</button><button className="button button--secondary" type="button" disabled={checking || connecting} onClick={onCheck}>{checking ? 'Checking…' : 'Test Calendar & Meet'}</button><button className="button button--secondary" type="button" disabled={connecting} onClick={onDisconnect}>Disconnect</button></> : <button className="button" type="button" disabled={loading || connecting || status?.configured === false} onClick={onConnect}>{connecting ? 'Connecting…' : 'Connect Google'}</button>}</div></section>;
}

function MeetingCard({ meeting, onOpen }: { meeting: PublicRecord; onOpen: () => void }) {
  const fields = meeting.fields;
  const link = String(fields.google_meet_link ?? fields.meeting_link ?? '').trim();
  const invitees = Array.isArray(fields.invitees) ? fields.invitees.length : Number(fields.invitee_count ?? 0);
  return <article className="content-card meeting-card" tabIndex={0} role="link" onClick={onOpen} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}>
    <div className="meeting-card__main"><div className="meeting-card__title"><span className="meeting-card__icon"><CalendarClock size={18} /></span><div><h2>{String(fields.title ?? fields.name ?? 'Untitled meeting')}</h2><span>{dateTime(fields.scheduled_start ?? fields.meeting_date ?? fields.start_at)}{fields.scheduled_end ? ` – ${dateTime(fields.scheduled_end)}` : ''}</span></div></div><StatusPill value={fields.status ?? 'scheduled'} /></div>
    <div className="meeting-card__meta"><span><UsersRound size={14} /> {invitees || 0} invitee{invitees === 1 ? '' : 's'}</span><span>Organizer #{String(fields.organizer_id ?? fields.created_by ?? '—')}</span>{String(fields.related_entity_type ?? '').trim() && <span>{String(fields.related_entity_type)} #{String(fields.related_entity_id ?? '—')}</span>}</div>
    <div className="meeting-card__actions">{link ? <a className="button button--small" href={link} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><ExternalLink size={14} /> Join Meet</a> : <span className="meeting-pending"><RefreshCw size={14} /> Meet link pending</span>}<button className="text-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }}>Open details <ChevronRight size={16} /></button></div>
  </article>;
}

function ScheduleMeetingDialog({ users, usersLoading, clients, clientsLoading, onClose, onCreated }: { users: PublicRecord[]; usersLoading: boolean; clients: PublicRecord[]; clientsLoading: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [agenda, setAgenda] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [timezone, setTimezone] = useState('Asia/Kolkata'); const [inviteeIds, setInviteeIds] = useState<number[]>([]); const [clientIds, setClientIds] = useState<number[]>([]); const [external, setExternal] = useState(''); const [reminder, setReminder] = useState('30'); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null); const [idempotencyKey] = useState(() => typeof window.crypto?.randomUUID === 'function' ? window.crypto.randomUUID() : `meeting-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const selectableUsers = useMemo(() => users.filter((record) => Number.isSafeInteger(record.legacyId) && (record.legacyId ?? 0) > 0), [users]);
  const selectableClients = useMemo(() => clients.filter((record) => Number.isSafeInteger(record.legacyId) && (record.legacyId ?? 0) > 0), [clients]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { const externalInvitees = external.split(/[,\n]/).map((email) => email.trim()).filter(Boolean); const from = new Date(start).getTime(); const to = new Date(end).getTime(); if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Meeting end time must be later than its start time.'); await api('/meetings', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ title, description, agenda, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(end).toISOString(), timezone, inviteeUserIds: inviteeIds, inviteeClientIds: clientIds, externalInvitees, calendarInvitations: true, whatsappNotification: false, reminderMinutes: [Number(reminder)] }) }); await onCreated(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not schedule the meeting.'); } finally { setSaving(false); } };
  const toggleInvitee = (id: number) => setInviteeIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const toggleClient = (id: number) => setClientIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal meeting-dialog" role="dialog" aria-modal="true" aria-label="Schedule meeting" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">GOOGLE MEET</p><h2>Schedule meeting</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={19} /></button></div><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>Title *</span><input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label><label className="field field--wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label><label className="field field--wide"><span>Agenda</span><textarea value={agenda} onChange={(event) => setAgenda(event.target.value)} rows={3} /></label><label className="field"><span>Start *</span><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} required /></label><label className="field"><span>End *</span><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} required /></label><label className="field"><span>Timezone</span><input value={timezone} onChange={(event) => setTimezone(event.target.value)} required /></label><label className="field"><span>Reminder</span><select value={reminder} onChange={(event) => setReminder(event.target.value)}><option value="0">At start</option><option value="15">15 minutes before</option><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></label><div className="field field--wide meeting-invitee-picker"><span>CRM employees</span>{usersLoading ? <small>Loading employees…</small> : selectableUsers.length ? <div className="meeting-invitee-list">{selectableUsers.map((record) => { const id = record.legacyId as number; const checked = inviteeIds.includes(id); return <label key={record.id} className={`meeting-invitee${checked ? ' meeting-invitee--selected' : ''}`}><input type="checkbox" checked={checked} onChange={() => toggleInvitee(id)} /><span>{String(record.fields.name ?? record.fields.email ?? `User #${id}`)}</span><small>{String(record.fields.email ?? '')}</small></label>; })}</div> : <small>No employee records are available for invitees.</small>}</div><div className="field field--wide meeting-invitee-picker"><span>CRM clients</span>{clientsLoading ? <small>Loading clients…</small> : selectableClients.length ? <div className="meeting-invitee-list">{selectableClients.map((record) => { const id = record.legacyId as number; const checked = clientIds.includes(id); return <label key={record.id} className={`meeting-invitee${checked ? ' meeting-invitee--selected' : ''}`}><input type="checkbox" checked={checked} onChange={() => toggleClient(id)} /><span>{String(record.fields.name ?? record.fields.company ?? `Client #${id}`)}</span><small>{String(record.fields.email ?? '')}</small></label>; })}</div> : <small>No client records are available for invitees.</small>}</div><label className="field field--wide"><span>External guest emails</span><input value={external} onChange={(event) => setExternal(event.target.value)} placeholder="guest@example.com, client@example.com" /><small>Separate addresses with commas. Google sends the calendar invitation.</small></label></div>{error && <p className="form-error" role="alert">{error}</p>}<p className="meeting-consent-note"><ShieldCheck size={15} /> Participants are informed that join/leave information may be recorded for attendance.</p><div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>Cancel</button><button className="button" type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create Google Meet'}</button></div></form></section></div>;
}

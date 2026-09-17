import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { getLegacyModel, type LegacyRecord } from '../db/legacy.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';
import { HttpError } from '../utils/http.js';

const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_MEET_SPACE_CREATED_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_REQUIRED_SCOPES = [GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_MEET_SPACE_CREATED_SCOPE];
const GOOGLE_SCOPES = ['openid', 'email', 'profile', ...GOOGLE_REQUIRED_SCOPES];
const GOOGLE_SETTINGS_KEY = 'google_oauth';
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/integrations/google/callback';
type GoogleOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; projectId: string | null; source: 'settings' | 'environment' };
export type GoogleOAuthPurpose = 'meetings' | 'backup';
export interface ConsumedOAuthState { userId: number; purpose: GoogleOAuthPurpose }
let oauthConfigCache: GoogleOAuthConfig | null | undefined;

export class GoogleMeetError extends HttpError {
  public readonly providerStatus: number | null;
  public readonly providerReason: string | null;
  public readonly providerMessage: string | null;

  constructor(
    message: string,
    public readonly code = 'google_error',
    status = 502,
    provider: { status?: number; reason?: string | null; message?: string | null } = {}
  ) {
    super(status, message);
    this.name = 'GoogleMeetError';
    this.providerStatus = Number.isInteger(provider.status) ? Number(provider.status) : null;
    this.providerReason = provider.reason?.trim() || null;
    this.providerMessage = provider.message?.trim() || null;
  }
}

export function googleIntegrationConfigured(): boolean {
  const config = oauthConfigCache === undefined ? environmentOAuthConfig() : oauthConfigCache;
  return Boolean(config?.clientId && config.clientSecret && config.redirectUri);
}

/** Loads the CEO-managed configuration once per process. Environment values
 * remain a safe fallback for deployments that have not configured the UI. */
export async function loadGoogleOAuthConfig(): Promise<GoogleOAuthConfig | null> {
  if (oauthConfigCache !== undefined) return oauthConfigCache;
  const [record] = await listRawRecords('app_settings', { 'raw.key': GOOGLE_SETTINGS_KEY }, 1);
  const clientId = text(record?.raw.client_id);
  const clientSecret = record ? decryptOptional(record.raw.client_secret_ciphertext) : null;
  const configuredRedirectUri = text(record?.raw.redirect_uri);
  // Older CEO settings accepted the site root or localhost as a redirect.
  // Normalize those values in memory and, in production, always use the
  // canonical public callback. Persist the correction so a future restart or
  // update cannot silently reintroduce the mismatch.
  const configured = normalizeGoogleRedirectUri(configuredRedirectUri);
  const environment = normalizeGoogleRedirectUri(env.GOOGLE_OAUTH_REDIRECT_URI);
  // A production callback must stay on the canonical public origin. Older
  // CEO settings sometimes contained a localhost callback; allowing that
  // value to win makes Google send the authorization code to a developer
  // machine and produces a misleading access-denied/connection failure.
  const canonical = defaultGoogleRedirectUri();
  const redirectUri = env.NODE_ENV === 'production'
    ? canonical
    : configured ?? environment ?? canonical;
  if (clientId && clientSecret && redirectUri) {
    oauthConfigCache = { clientId, clientSecret, redirectUri, projectId: text(record?.raw.project_id) || text(env.GOOGLE_CLOUD_PROJECT_ID) || null, source: 'settings' };
    if (record?.legacyId && configuredRedirectUri !== redirectUri) {
      await updateLegacyRecord('app_settings', record.legacyId, { redirect_uri: redirectUri, redirect_uri_normalized_at: nowIso() }).catch(() => undefined);
    }
  } else {
    oauthConfigCache = environmentOAuthConfig();
  }
  return oauthConfigCache;
}

export async function readGoogleOAuthConfigStatus() {
  const [record] = await listRawRecords('app_settings', { 'raw.key': GOOGLE_SETTINGS_KEY }, 1);
  const config = await loadGoogleOAuthConfig();
  return { configured: Boolean(config), source: config?.source ?? 'not_configured', clientId: config?.clientId ?? null, redirectUri: config?.redirectUri ?? null, expectedRedirectUri: defaultGoogleRedirectUri(), projectId: config?.projectId ?? null, storedClientSecret: Boolean(record && decryptOptional(record.raw.client_secret_ciphertext)), updatedAt: record ? String(record.raw.updated_at ?? record.updatedAt.toISOString()) : null };
}

export async function saveGoogleOAuthConfig(input: { clientId: string; clientSecret?: string | null; redirectUri: string; projectId?: string | null; updatedBy: number }) {
  const current = await loadGoogleOAuthConfig();
  const secret = input.clientSecret?.trim() || current?.clientSecret;
  if (!secret) throw new GoogleMeetError('Enter the Google OAuth client secret.', 'google_client_secret_required', 400);
  const redirectUri = normalizeGoogleRedirectUri(input.redirectUri);
  if (!redirectUri) throw new GoogleMeetError(`Use the exact Google callback URL ending in ${GOOGLE_OAUTH_CALLBACK_PATH}.`, 'google_redirect_uri_invalid', 400);
  if (env.NODE_ENV === 'production' && redirectUri !== defaultGoogleRedirectUri()) {
    throw new GoogleMeetError(`Production Google OAuth must use ${defaultGoogleRedirectUri()}.`, 'google_redirect_uri_invalid', 400);
  }
  const now = nowIso();
  const [record] = await listRawRecords('app_settings', { 'raw.key': GOOGLE_SETTINGS_KEY }, 1);
  const fields = { key: GOOGLE_SETTINGS_KEY, client_id: input.clientId.trim(), client_secret_ciphertext: encrypt(secret), redirect_uri: redirectUri, project_id: input.projectId?.trim() || null, updated_by: input.updatedBy, updated_at: now, configured_at: record?.raw.configured_at ?? now };
  const saved = record?.legacyId ? await updateLegacyRecord('app_settings', record.legacyId, fields) : await createLegacyRecord('app_settings', { ...fields, created_by: input.updatedBy, created_at: now });
  if (!saved) throw new GoogleMeetError('Google OAuth configuration could not be saved.', 'google_config_save_failed', 500);
  oauthConfigCache = { clientId: fields.client_id, clientSecret: secret, redirectUri: fields.redirect_uri, projectId: fields.project_id, source: 'settings' };
  const clientChanged = Boolean(current && (current.clientId !== fields.client_id || current.clientSecret !== secret || current.redirectUri !== fields.redirect_uri));
  if (clientChanged) {
    // Tokens minted for a different OAuth client (or an old callback) cannot
    // be refreshed reliably with the new credentials. Force a clean consent
    // flow instead of letting the next meeting fail with a misleading 403.
    const connected = await listRawRecords('google_integrations', { 'raw.connected': true }, 10_000);
    await Promise.all(connected.filter((integration) => Boolean(integration.legacyId)).map((integration) => updateLegacyRecord('google_integrations', integration.legacyId as number, {
      connected: false,
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      disconnected_at: now,
      last_error: 'Google OAuth client changed; reconnect required.',
      updated_at: now
    })));
  }
  return readGoogleOAuthConfigStatus();
}

export async function clearGoogleOAuthConfig(updatedBy: number) {
  const [record] = await listRawRecords('app_settings', { 'raw.key': GOOGLE_SETTINGS_KEY }, 1);
  if (record?.legacyId) await updateLegacyRecord('app_settings', record.legacyId, { key: GOOGLE_SETTINGS_KEY, client_id: null, client_secret_ciphertext: null, redirect_uri: null, project_id: null, cleared_by: updatedBy, updated_by: updatedBy, updated_at: nowIso() });
  oauthConfigCache = environmentOAuthConfig();
  return readGoogleOAuthConfigStatus();
}

export async function createOAuthState(userId: number, purpose: GoogleOAuthPurpose = 'meetings'): Promise<string> {
  const state = crypto.randomBytes(32).toString('hex');
  await createLegacyRecord('meeting_oauth_states', { state, user_id: userId, purpose, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), created_at: nowIso() });
  return state;
}

export function googleAuthorizationUrl(state: string, purpose: GoogleOAuthPurpose = 'meetings'): string {
  const config = oauthConfigCache === undefined ? environmentOAuthConfig() : oauthConfigCache;
  if (!config) throw new GoogleMeetError('Google OAuth is not configured by the CEO.', 'google_not_configured', 503);
  const scopes = purpose === 'backup'
    ? ['openid', 'email', 'profile', GOOGLE_DRIVE_FILE_SCOPE]
    : GOOGLE_SCOPES;
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', select_account: 'true', scope: scopes.join(' '), state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function consumeOAuthState(state: string): Promise<ConsumedOAuthState | null> {
  // Claim the state atomically after checking its short expiry window. This
  // prevents a browser refresh or concurrent callback from reusing the same
  // authorization code.
  const record = await findByState(state);
  if (!record || new Date(String(record.raw.expires_at ?? '')).getTime() < Date.now()) return null;
  const claimed = await getLegacyModel('meeting_oauth_states').findOneAndUpdate(
    { _id: record._id, 'raw.consumed_at': { $exists: false }, archivedAt: { $exists: false } },
    { $set: { 'raw.consumed_at': nowIso() } },
    { new: true }
  ).lean<LegacyRecord | null>();
  if (!claimed) return null;
  const userId = numeric(claimed.raw.user_id);
  if (!userId) return null;
  const purpose = claimed.raw.purpose === 'backup' ? 'backup' : 'meetings';
  return { userId, purpose };
}

export async function exchangeGoogleCode(code: string, userId: number, purpose: GoogleOAuthPurpose = 'meetings'): Promise<GoogleIntegrationStatus> {
  const config = await loadGoogleOAuthConfig();
  if (!config) throw new GoogleMeetError('Google OAuth is not configured by the CEO.', 'google_not_configured', 503);
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }) });
  const payload = await jsonObject(response);
  if (!response.ok || typeof payload.access_token !== 'string') {
    const providerCode = text(payload.error);
    const providerDescription = sanitizeProviderMessage(text(payload.error_description));
    if (providerCode === 'access_denied') {
      const feature = purpose === 'backup' ? 'Drive backup' : 'Calendar or Meet';
      throw new GoogleMeetError(`Google denied ${feature} access for this account. Add this account as an OAuth test user (or publish the consent screen), then reconnect and approve the requested permissions.`, 'google_permission_denied', 400, { message: providerDescription });
    }
    const feature = purpose === 'backup' ? 'Drive backup' : 'Calendar and Meet';
    throw new GoogleMeetError(providerDescription ? `Google did not grant ${feature} access: ${providerDescription}` : `Google did not grant ${feature} access. Reconnect and approve the requested permissions.`, 'google_oauth_denied', 400, { message: providerDescription });
  }
  const accessToken = String(payload.access_token);
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : null;
  const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  const userInfo = await jsonObject(userInfoResponse);
  const [existing] = await listRawRecords('google_integrations', { 'raw.user_id': userId }, 1);
  const fields = {
    user_id: userId,
    google_account_id: String(userInfo.sub ?? ''),
    email: String(userInfo.email ?? ''),
    encrypted_access_token: encrypt(accessToken),
    ...(refreshToken ? { encrypted_refresh_token: encrypt(refreshToken) } : {}),
    token_expiry: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
    scopes: normalizeScopes(payload.scope),
    connected: true,
    connected_at: nowIso(),
    disconnected_at: null,
    last_error: null,
    updated_at: nowIso()
  };
  const saved = existing?.legacyId ? await updateLegacyRecord('google_integrations', existing.legacyId, fields) : await createLegacyRecord('google_integrations', { ...fields, created_at: nowIso() });
  if (!saved) throw new GoogleMeetError('Google integration could not be saved.', 'google_integration_save_failed', 500);
  return publicIntegration(saved);
}

export async function disconnectGoogle(userId: number): Promise<void> {
  const [record] = await listRawRecords('google_integrations', { 'raw.user_id': userId }, 1);
  if (!record?.legacyId) return;
  await updateLegacyRecord('google_integrations', record.legacyId, { connected: false, encrypted_access_token: null, encrypted_refresh_token: null, disconnected_at: nowIso(), updated_at: nowIso() });
}

export async function integrationStatus(userId: number): Promise<GoogleIntegrationStatus> {
  await loadGoogleOAuthConfig();
  const [record] = await listRawRecords('google_integrations', { 'raw.user_id': userId }, 1);
  return record ? publicIntegration(record) : { connected: false, configured: googleIntegrationConfigured(), email: null, connectedAt: null, scopes: [], requiredScopes: GOOGLE_REQUIRED_SCOPES, lastError: null };
}

export async function getGoogleAccessToken(userId: number): Promise<string> {
  const config = await loadGoogleOAuthConfig();
  if (!config) throw new GoogleMeetError('Google OAuth is not configured by the CEO.', 'google_not_configured', 503);
  const [record] = await listRawRecords('google_integrations', { 'raw.user_id': userId, 'raw.connected': true }, 1);
  if (!record) throw new GoogleMeetError('Connect your Google account before using this Google feature.', 'google_not_connected', 400);
  const access = decryptOptional(record.raw.encrypted_access_token);
  const refresh = decryptOptional(record.raw.encrypted_refresh_token);
  const expiry = new Date(String(record.raw.token_expiry ?? '')).getTime();
  if (access && Number.isFinite(expiry) && expiry > Date.now() + 60_000) return access;
  if (!refresh) throw new GoogleMeetError('The Google session has expired. Reconnect your account.', 'google_reconnect_required', 401);
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const payload = await jsonObject(response);
  if (!response.ok || typeof payload.access_token !== 'string') {
    if (record.legacyId) await updateLegacyRecord('google_integrations', record.legacyId, { connected: false, last_error: 'Google token refresh failed.', updated_at: nowIso() });
    throw new GoogleMeetError('Google access was revoked or expired. Reconnect your account.', 'google_reconnect_required', 401);
  }
  const refreshed = String(payload.access_token);
  if (record.legacyId) await updateLegacyRecord('google_integrations', record.legacyId, { encrypted_access_token: encrypt(refreshed), token_expiry: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(), updated_at: nowIso(), last_error: null });
  return refreshed;
}

export async function googleCalendarCreate(userId: number, event: CalendarEventInput): Promise<GoogleCalendarEvent> {
  if (!validTimeZone(event.timezone)) throw new GoogleMeetError('Use a valid IANA timezone such as Asia/Kolkata before creating the meeting.', 'google_timezone_invalid', 400);
  const token = await getGoogleAccessToken(userId);
  const requestId = crypto.randomBytes(18).toString('hex');
  const sendUpdates = event.sendUpdates ?? 'all';
  const attendees = [...new Set(event.attendees.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (attendees.length > 200) throw new GoogleMeetError('Google Calendar supports up to 200 invitees per meeting. Remove some invitees and try again.', 'google_attendee_limit', 400);
  const invalidAttendee = attendees.find((email) => !isEmail(email));
  if (invalidAttendee) throw new GoogleMeetError('One or more invitee email addresses are invalid. Remove them and try again.', 'google_invalid_attendee', 400, { message: invalidAttendee });
  const params = new URLSearchParams({ conferenceDataVersion: '1', sendUpdates });
  return googleRequest<GoogleCalendarEvent>(token, 'POST', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
    summary: event.title,
    description: event.description,
    start: { dateTime: event.start, timeZone: event.timezone },
    end: { dateTime: event.end, timeZone: event.timezone },
    attendees: attendees.map((email) => ({ email })),
    conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  });
}

/** Performs a lightweight authenticated Calendar request without creating an
 * event. This lets production admins verify the connected account and scope
 * before a user opens the scheduling dialog. */
export async function googleCalendarCheck(userId: number): Promise<{ id: string | null; summary: string | null; timeZone: string | null }> {
  // List events rather than reading calendar metadata: the requested
  // calendar.events scope is sufficient for this check and does not require a
  // broader calendar.readonly scope.
  const params = new URLSearchParams({ maxResults: '1', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date().toISOString(), fields: 'items(id)' });
  const calendar = await googleRequest<Record<string, unknown>>(await getGoogleAccessToken(userId), 'GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`);
  return {
    id: Array.isArray(calendar.items) ? 'primary' : null,
    summary: text(calendar.summary) || 'Primary calendar',
    timeZone: text(calendar.timeZone) || null
  };
}

/**
 * Runs non-mutating probes against both provider APIs. Calendar events.list
 * validates the Calendar API and the events scope; conferenceRecords.list
 * validates the Meet REST API and meetings.space.created scope. Keeping these
 * checks separate makes a missing API or scope visible before a meeting is
 * created, rather than surfacing as a vague 500 from the scheduler.
 */
export async function googleIntegrationCheck(userId: number): Promise<GoogleIntegrationCheck> {
  const status = await integrationStatus(userId);
  const missingScopes = GOOGLE_REQUIRED_SCOPES.filter((scope) => !status.scopes.includes(scope));
  const disconnected: GoogleServiceProbe = { ok: false, message: 'Connect an authorised Google account first.', httpStatus: 400 };
  if (!status.connected) {
    return { ready: false, accountEmail: status.email, scopes: status.scopes, missingScopes, calendar: disconnected, meet: disconnected, message: disconnected.message };
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(userId);
  } catch (error) {
    const message = error instanceof GoogleMeetError ? error.message : 'Reconnect the Google account before checking Calendar and Meet.';
    const failed: GoogleServiceProbe = { ok: false, message, httpStatus: error instanceof GoogleMeetError ? error.providerStatus : null };
    return { ready: false, accountEmail: status.email, scopes: status.scopes, missingScopes, calendar: failed, meet: failed, message };
  }

  const calendar = await probeGoogleService('Calendar', () => {
    const params = new URLSearchParams({ maxResults: '1', singleEvents: 'true', orderBy: 'startTime', timeMin: new Date().toISOString(), fields: 'items(id),summary,timeZone' });
    return googleRequest<Record<string, unknown>>(token, 'GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`);
  });
  const meet = await probeGoogleService('Meet', () => googleRequest<{ conferenceRecords?: unknown[] }>(token, 'GET', 'https://meet.googleapis.com/v2/conferenceRecords?pageSize=1'));
  const ready = calendar.ok && meet.ok && missingScopes.length === 0;
  const message = ready ? null : buildIntegrationCheckMessage({ calendar, meet, missingScopes });
  return { ready, accountEmail: status.email, scopes: status.scopes, missingScopes, calendar, meet, message };
}

export async function googleCalendarGet(userId: number, eventId: string): Promise<GoogleCalendarEvent> {
  return googleRequest<GoogleCalendarEvent>(await getGoogleAccessToken(userId), 'GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`);
}

export async function googleCalendarUpdate(userId: number, eventId: string, event: Partial<CalendarEventInput>): Promise<GoogleCalendarEvent> {
  if (event.timezone && !validTimeZone(event.timezone)) throw new GoogleMeetError('Use a valid IANA timezone such as Asia/Kolkata before rescheduling the meeting.', 'google_timezone_invalid', 400);
  const token = await getGoogleAccessToken(userId);
  const params = new URLSearchParams({ conferenceDataVersion: '1', sendUpdates: 'all' });
  return googleRequest<GoogleCalendarEvent>(token, 'PATCH', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?${params.toString()}`, {
    ...(event.title ? { summary: event.title } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.start ? { start: { dateTime: event.start, timeZone: event.timezone } } : {}),
    ...(event.end ? { end: { dateTime: event.end, timeZone: event.timezone } } : {})
  });
}

export async function googleCalendarCancel(userId: number, eventId: string): Promise<void> {
  const params = new URLSearchParams({ sendUpdates: 'all' });
  await googleRequest(await getGoogleAccessToken(userId), 'DELETE', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?${params.toString()}`);
}

export async function googleMeetConferenceRecords(userId: number, spaceName: string): Promise<Record<string, unknown> | null> {
  const token = await getGoogleAccessToken(userId);
  const filter = encodeURIComponent(`space.meeting_code = "${spaceName.replace(/^.*\//, '')}"`);
  const payload = await googleRequest<{ conferenceRecords?: Array<Record<string, unknown>> }>(token, 'GET', `https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`);
  return payload.conferenceRecords?.[0] ?? null;
}

export async function googleMeetParticipants(userId: number, conferenceRecordName: string): Promise<Array<Record<string, unknown>>> {
  const token = await getGoogleAccessToken(userId);
  const payload = await googleRequest<{ participants?: Array<Record<string, unknown>> }>(token, 'GET', `https://meet.googleapis.com/v2/${conferenceRecordName}/participants?pageSize=1000`);
  return payload.participants ?? [];
}

/** Returns every join/rejoin session for one Meet participant. The resource
 * name is returned by the authoritative Meet participants endpoint, so a
 * repeat attendance sync can upsert the same sessions without inventing IDs. */
export async function googleMeetParticipantSessions(userId: number, participantResourceName: string): Promise<Array<Record<string, unknown>>> {
  const token = await getGoogleAccessToken(userId);
  const payload = await googleRequest<{ participantSessions?: Array<Record<string, unknown>> }>(token, 'GET', `https://meet.googleapis.com/v2/${participantResourceName}/participantSessions?pageSize=1000`);
  return payload.participantSessions ?? [];
}

export function extractMeetLink(event: GoogleCalendarEvent): string | null {
  const direct = typeof event.hangoutLink === 'string' ? event.hangoutLink : null;
  if (direct) return direct;
  const entries = event.conferenceData?.entryPoints;
  const video = Array.isArray(entries) ? entries.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).entryPointType === 'video') : undefined;
  const uri = video && typeof video === 'object' ? (video as Record<string, unknown>).uri : null;
  return typeof uri === 'string' ? uri : null;
}

export interface GoogleIntegrationStatus { connected: boolean; configured: boolean; email: string | null; connectedAt: string | null; scopes: string[]; requiredScopes: string[]; lastError: string | null }
export interface GoogleServiceProbe { ok: boolean; message: string | null; httpStatus: number | null }
export interface GoogleIntegrationCheck { ready: boolean; accountEmail: string | null; scopes: string[]; missingScopes: string[]; calendar: GoogleServiceProbe; meet: GoogleServiceProbe; message: string | null }
export interface CalendarEventInput { title: string; description?: string; start: string; end: string; timezone: string; attendees: string[]; sendUpdates?: 'all' | 'none' }
export interface GoogleCalendarEvent { id?: string; hangoutLink?: string; status?: string; conferenceData?: { conferenceId?: string; conferenceSolution?: { name?: string }; createRequest?: { status?: { statusCode?: string } }; entryPoints?: Array<Record<string, unknown>> }; start?: Record<string, unknown>; end?: Record<string, unknown> }

function publicIntegration(record: LegacyRecord): GoogleIntegrationStatus { return { connected: bool(record.raw.connected), configured: googleIntegrationConfigured(), email: String(record.raw.email ?? '').trim() || null, connectedAt: String(record.raw.connected_at ?? '').trim() || null, scopes: Array.isArray(record.raw.scopes) ? record.raw.scopes.map(String) : [], requiredScopes: GOOGLE_REQUIRED_SCOPES, lastError: String(record.raw.last_error ?? '').trim() || null }; }
function environmentOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const configured = normalizeGoogleRedirectUri(env.GOOGLE_OAUTH_REDIRECT_URI);
  const redirectUri = env.NODE_ENV === 'production' ? defaultGoogleRedirectUri() : configured ?? defaultGoogleRedirectUri();
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri, projectId: env.GOOGLE_CLOUD_PROJECT_ID ?? null, source: 'environment' } : null;
}
export function normalizeGoogleRedirectUri(value: string | null | undefined): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (pathname !== '/' && pathname !== GOOGLE_OAUTH_CALLBACK_PATH) return null;
    parsed.pathname = GOOGLE_OAUTH_CALLBACK_PATH;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
function defaultGoogleRedirectUri(): string { return `${publicOrigin()}${GOOGLE_OAUTH_CALLBACK_PATH}`; }
function publicOrigin(): string {
  const configured = [env.APP_ORIGIN, env.CORS_ORIGIN].filter((value): value is string => Boolean(value)).flatMap((value) => value.split(','));
  for (const value of configured) {
    try {
      const parsed = new URL(value.trim());
      if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') continue;
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && (parsed.pathname === '/' || parsed.pathname === '')) return parsed.origin;
    } catch { /* try the next configured origin */ }
  }
  return env.NODE_ENV === 'production' ? 'https://www.kakicrm.store' : 'http://localhost:5173';
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function normalizeScopes(value: unknown): string[] {
  const scopes = typeof value === 'string' ? value.split(/\s+/) : Array.isArray(value) ? value : [];
  return [...new Set(scopes.map(String).map((scope) => scope.trim()).filter(Boolean))];
}
async function findByState(state: string): Promise<LegacyRecord | null> { const [record] = await listRawRecords('meeting_oauth_states', { 'raw.state': state, 'raw.consumed_at': { $exists: false } }, 1); return record ?? null; }
async function probeGoogleService(service: 'Calendar' | 'Meet', request: () => Promise<unknown>): Promise<GoogleServiceProbe> {
  try {
    await request();
    return { ok: true, message: null, httpStatus: null };
  } catch (error) {
    if (error instanceof GoogleMeetError) {
      const denied = error.code === 'google_permission_denied' || error.providerStatus === 403;
      const message = denied
        ? `Google ${service} access was denied. Enable the ${service === 'Calendar' ? 'Google Calendar API' : 'Google Meet REST API'} in the OAuth client's Cloud project, add this account as a consent-screen test user if the app is in Testing, then disconnect and reconnect.`
        : error.message;
      return { ok: false, message, httpStatus: error.providerStatus };
    }
    return { ok: false, message: `Google ${service} could not be checked. Reconnect the Google account and try again.`, httpStatus: null };
  }
}
function buildIntegrationCheckMessage(input: { calendar: GoogleServiceProbe; meet: GoogleServiceProbe; missingScopes: string[] }): string {
  if (!input.calendar.ok && input.calendar.message) return input.calendar.message;
  if (!input.meet.ok && input.meet.message) return input.meet.message;
  if (input.missingScopes.length) return 'The connected Google account did not grant both Calendar events and Meet permissions. Disconnect and reconnect, then approve every requested permission.';
  return 'Google Calendar and Meet are not ready. Check the APIs, OAuth test-user access, and reconnect the account.';
}
async function googleRequest<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    throw new GoogleMeetError(
      timedOut
        ? 'Google Calendar took too long to respond. Check the server connection and try again.'
        : 'Google Calendar could not be reached from the server. Check outbound HTTPS/DNS and try again.',
      timedOut ? 'google_timeout' : 'google_network_error',
      503
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = await jsonObject(response);
  if (!response.ok) {
    const provider = providerError(payload, response.status);
    throw new GoogleMeetError(provider.userMessage, provider.code, provider.httpStatus, provider);
  }
  return payload as T;
}
async function jsonObject(response: Response): Promise<Record<string, unknown>> { const value: unknown = await response.json().catch(() => ({})); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function providerError(payload: Record<string, unknown>, responseStatus: number): { code: string; httpStatus: number; status: number; reason: string | null; message: string | null; userMessage: string } {
  const rawError = payload.error;
  const details = rawError && typeof rawError === 'object' && !Array.isArray(rawError) ? rawError as Record<string, unknown> : {};
  const message = text(details.message) || text(payload.error_description) || null;
  const statusName = text(details.status).toUpperCase();
  const errors = Array.isArray(details.errors) ? details.errors : [];
  const firstError = errors.find((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
  const reason = text(firstError?.reason) || text(details.reason) || null;
  const normalized = `${reason ?? ''} ${statusName} ${message ?? ''}`.toLowerCase();
  const isAuth = responseStatus === 401 || statusName === 'UNAUTHENTICATED' || normalized.includes('invalid credentials') || normalized.includes('insufficient authentication');
  const isPermission = responseStatus === 403 || statusName === 'PERMISSION_DENIED' || normalized.includes('insufficient permission') || normalized.includes('accessnotconfigured');
  const isInvalidAttendee = normalized.includes('attendee') && (normalized.includes('invalid') || normalized.includes('email'));
  const isUnavailable = responseStatus === 429 || responseStatus >= 500;
  if (isAuth) {
    return { code: 'google_reconnect_required', httpStatus: 401, status: responseStatus, reason, message, userMessage: 'Your Google Calendar connection expired or was revoked. Disconnect and reconnect Google Calendar, then try again.' };
  }
  if (isPermission) {
    return { code: 'google_permission_denied', httpStatus: 502, status: responseStatus, reason, message, userMessage: 'Google denied Calendar or Meet access for this account. Reconnect Google Calendar and approve the Calendar and Meet permissions; also confirm the Google Calendar API and Google Meet API are enabled in Google Cloud.' };
  }
  if (isInvalidAttendee) {
    return { code: 'google_invalid_attendee', httpStatus: 400, status: responseStatus, reason, message, userMessage: 'Google rejected one or more invitee email addresses. Remove the invalid invitee and try again.' };
  }
  if (isUnavailable) {
    return { code: 'google_provider_unavailable', httpStatus: 503, status: responseStatus, reason, message, userMessage: 'Google Calendar is temporarily unavailable. Wait a moment and try again.' };
  }
  const safeProviderMessage = sanitizeProviderMessage(message);
  return { code: 'google_api_error', httpStatus: responseStatus >= 400 && responseStatus < 500 ? 400 : 502, status: responseStatus, reason, message, userMessage: safeProviderMessage ? `Google rejected the meeting request: ${safeProviderMessage}` : `Google rejected the meeting request (HTTP ${responseStatus}). Check the meeting details and connected account.` };
}
function sanitizeProviderMessage(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/https?:\/\/[^\s]+/gi, '[provider link]').replace(/\s+/g, ' ').trim();
  return cleaned.length > 260 ? `${cleaned.slice(0, 257)}…` : cleaned;
}
function isEmail(value: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function encryptionKey(): Buffer { return crypto.createHash('sha256').update(env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? env.SETTINGS_ENCRYPTION_SECRET ?? env.JWT_ACCESS_SECRET).digest(); }
function encrypt(value: string): string { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.'); }
function decryptOptional(value: unknown): string | null { if (typeof value !== 'string' || !value) return null; try { const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url')); const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'); } catch { return null; } }
function numeric(value: unknown): number | null { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; }
function bool(value: unknown): boolean { return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()); }
function nowIso(): string { return new Date().toISOString(); }

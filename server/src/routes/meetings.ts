import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { type LegacyRecord, toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { can, isAdminOrHrRole, isCeoRole, type AuthContext } from '../services/permissions.js';
import {
  archiveLegacyRecord,
  createLegacyRecord,
  findLegacyRecord,
  listLegacyRecords,
  listRawRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import {
  consumeOAuthState,
  createOAuthState,
  disconnectGoogle,
  exchangeGoogleCode,
  extractMeetLink,
  googleAuthorizationUrl,
  googleIntegrationCheck,
  googleCalendarCancel,
  googleCalendarCreate,
  googleCalendarGet,
  googleCalendarUpdate,
  googleMeetConferenceRecords,
  googleMeetParticipantSessions,
  googleMeetParticipants,
  integrationStatus,
  loadGoogleOAuthConfig
} from '../services/googleMeet.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const meetingStatuses = ['creating', 'scheduled', 'in_progress', 'completed', 'cancelled', 'failed'] as const;
const meetingSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(20_000).optional().nullable(),
  agenda: z.string().trim().max(10_000).optional().nullable(),
  internalNotes: z.string().trim().max(10_000).optional().nullable(),
  scheduledStart: z.string().trim().min(1).max(80),
  scheduledEnd: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(80).default('Asia/Kolkata'),
  inviteeUserIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  inviteeClientIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  externalInvitees: z.array(z.string().email().max(180)).max(100).default([]),
  relatedEntityType: z.string().trim().max(80).optional().nullable(),
  relatedEntityId: z.coerce.number().int().positive().optional().nullable(),
  calendarInvitations: z.boolean().default(true),
  whatsappNotification: z.boolean().default(false),
  reminderMinutes: z.array(z.coerce.number().int().min(0).max(10080)).max(10).default([30])
});
const meetingPatchSchema = meetingSchema.partial().omit({ inviteeUserIds: true, inviteeClientIds: true, externalInvitees: true, calendarInvitations: true, whatsappNotification: true, reminderMinutes: true });
const rescheduleSchema = z.object({ scheduledStart: z.string().trim().min(1).max(80), scheduledEnd: z.string().trim().min(1).max(80), timezone: z.string().trim().min(1).max(80).optional() });
const cancelSchema = z.object({ reason: z.string().trim().min(1).max(5_000) });
const linkParticipantSchema = z.object({ userId: z.coerce.number().int().positive().optional(), clientId: z.coerce.number().int().positive().optional() }).refine((value) => value.userId || value.clientId, 'Choose a CRM user or client.');
const meetingMutationRateLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

export const googleIntegrationRouter = Router();
// The OAuth callback arrives without the bearer header after Google redirects
// the browser back. Its one-time state token is the authentication boundary;
// all management/status endpoints below still require the CRM bearer token.
googleIntegrationRouter.get('/callback', asyncHandler(async (req, res) => {
  const state = stringQuery(req.query.state);
  const providerError = stringQuery(req.query.error);
  if (providerError) {
    // Google sends access_denied when the consent screen is still in Testing
    // and the signed-in account is not listed as a test user. Return to the
    // CRM with a safe, human-readable code instead of exposing a raw error.
    const consumed = state ? await consumeOAuthState(state) : null;
    const origin = safeOrigin();
    const destination = consumed?.purpose === 'backup' ? '/admin/backups' : '/data/meetings';
    res.redirect(`${origin}${destination}?google=error&reason=${encodeURIComponent(providerError)}`);
    return;
  }
  const code = stringQuery(req.query.code);
  if (!state || !code) throw new HttpError(400, 'Google authorization was not completed.');
  const consumed = await consumeOAuthState(state);
  if (!consumed) throw new HttpError(400, 'This Google authorization link has expired. Start the connection again.');
  await exchangeGoogleCode(code, consumed.userId, consumed.purpose);
  const origin = safeOrigin();
  const destination = consumed.purpose === 'backup' ? '/admin/backups' : '/data/meetings';
  res.redirect(`${origin}${destination}?google=connected`);
}));

googleIntegrationRouter.use(requireAuth);
googleIntegrationRouter.get('/status', requireIntegrationManage, asyncHandler(async (req, res) => {
  res.json({ data: await integrationStatus(req.auth!.legacyId) });
}));
googleIntegrationRouter.get('/check', requireIntegrationManage, asyncHandler(async (req, res) => {
  // Two harmless authenticated reads give administrators an immediate answer
  // for both APIs/scopes before a create request is attempted. The response
  // deliberately keeps Calendar and Meet results separate so a missing API or
  // consent grant is not hidden behind a generic 500.
  res.json({ data: await googleIntegrationCheck(req.auth!.legacyId) });
}));
googleIntegrationRouter.get('/connect', requireIntegrationManage, asyncHandler(async (req, res) => {
  await loadGoogleOAuthConfig();
  const state = await createOAuthState(req.auth!.legacyId, 'meetings');
  res.json({ url: googleAuthorizationUrl(state, 'meetings') });
}));
googleIntegrationRouter.delete('/disconnect', requireIntegrationManage, asyncHandler(async (req, res) => {
  await disconnectGoogle(req.auth!.legacyId);
  res.status(204).send();
}));

export const meetingsRouter = Router();
meetingsRouter.use(requireAuth);

meetingsRouter.get('/upcoming', requireMeetingRead, asyncHandler(async (req, res) => {
  const result = await listMeetingRecords(req, { upcoming: true });
  res.json(result);
}));

meetingsRouter.get('/', requireMeetingRead, asyncHandler(async (req, res) => {
  const result = await listMeetingRecords(req);
  res.json(result);
}));

meetingsRouter.post('/', meetingMutationRateLimit, requireMeetingCreate, asyncHandler(async (req, res) => {
  const input = meetingSchema.parse(req.body);
  validateTimes(input.scheduledStart, input.scheduledEnd);
  const userIds = [...new Set(input.inviteeUserIds)];
  const inviteeRows = userIds.length ? await listRawRecords('users', { legacyId: { $in: userIds } }, userIds.length) : [];
  if (inviteeRows.length !== userIds.length) throw new HttpError(400, 'One or more invitees could not be found.');
  const invitees = inviteeRows.map((user) => ({ crm_user: user.legacyId, display_name: String(user.raw.name ?? user.raw.email ?? `#${user.legacyId}`), email: String(user.raw.email ?? '').trim() || null, invited: true, invitation_status: 'pending', attendance_status: 'unknown' }));
  const clientIds = [...new Set(input.inviteeClientIds)];
  const clientRows = clientIds.length ? await listRawRecords('clients', { legacyId: { $in: clientIds } }, clientIds.length) : [];
  if (clientRows.length !== clientIds.length) throw new HttpError(400, 'One or more client invitees could not be found.');
  const clientInvitees = clientRows.map((client) => ({ client_id: client.legacyId, display_name: String(client.raw.name ?? client.raw.company ?? `Client #${client.legacyId}`), email: String(client.raw.email ?? '').trim() || null, invited: true, invitation_status: 'pending', attendance_status: 'unknown' }));
  const allInvitees = [...invitees, ...clientInvitees];
  const attendees = [...new Set([...allInvitees.map((invitee) => invitee.email).filter((email): email is string => Boolean(email)), ...input.externalInvitees])];
  const organizerId = req.auth!.legacyId;
  const idempotencyKey = String(req.headers['idempotency-key'] ?? '').trim().slice(0, 160);
  if (idempotencyKey) {
    const [existing] = await listRawRecords('meetings', { 'raw.idempotency_key': idempotencyKey, 'raw.organizer_id': organizerId }, 1);
    if (existing) {
      res.status(200).json({ data: toPublicRecord(existing), idempotentReplay: true });
      return;
    }
  }
  const calendarEvent = await googleCalendarCreate(organizerId, { title: input.title, description: [input.description, input.agenda].filter(Boolean).join('\n\n'), start: toIso(input.scheduledStart), end: toIso(input.scheduledEnd), timezone: input.timezone, attendees, sendUpdates: input.calendarInvitations ? 'all' : 'none' });
  const eventId = String(calendarEvent.id ?? '').trim();
  if (!eventId) throw new HttpError(502, 'Google Calendar did not return an event identifier.');
  let resolvedEvent = calendarEvent;
  let meetLink = extractMeetLink(resolvedEvent);
  for (let attempt = 0; !meetLink && attempt < 4; attempt += 1) {
    await wait(300 * (2 ** attempt));
    try { resolvedEvent = await googleCalendarGet(organizerId, eventId); meetLink = extractMeetLink(resolvedEvent); } catch { /* The next bounded poll or retry can resolve the conference. */ }
  }
  const createdAt = nowIso();
  const meeting = await createLegacyRecord('meetings', {
    title: input.title,
    description: input.description ?? '',
    agenda: input.agenda ?? '',
    internal_notes: input.internalNotes ?? '',
    organizer_id: organizerId,
    created_by: organizerId,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    google_calendar_event_id: eventId,
    google_meet_link: meetLink,
    google_meet_code: resolvedEvent.conferenceData?.conferenceId ?? null,
    scheduled_start: input.scheduledStart,
    scheduled_end: input.scheduledEnd,
    timezone: input.timezone,
    status: meetLink ? 'scheduled' : 'creating',
    related_entity_type: input.relatedEntityType ?? null,
    related_entity_id: input.relatedEntityId ?? null,
    invitees: allInvitees,
    external_invitees: input.externalInvitees,
    participants: [],
    absent_invitees: [],
    reminders: input.reminderMinutes.map((minutes) => ({ channel: 'crm', minutes_before: minutes, status: 'scheduled' })),
    calendar_invitations: input.calendarInvitations,
    whatsapp_notification: input.whatsappNotification,
    attendance_sync_status: 'pending',
    created_at: createdAt,
    updated_at: createdAt
  });
  await writeMeetingActivity('meeting.created', meeting, req.auth!.legacyId);
  if (meetLink) await notifyMeetingInvitees(meeting, allInvitees.map((invitee) => Number('crm_user' in invitee ? invitee.crm_user : 0)).filter(isPositive), req.auth!, 'scheduled');
  emitRealtime('meeting:created', { meeting: toPublicRecord(meeting) }, 'workforce');
  res.status(meetLink ? 201 : 202).json({ data: toPublicRecord(meeting), conferencePending: !meetLink });
}));

meetingsRouter.get('/:meetingId', requireMeetingRead, asyncHandler(async (req, res) => {
  const meeting = await hydratePendingMeeting(await visibleMeeting(req, idParam(req.params.meetingId)));
  res.json({ data: toPublicRecord(meeting) });
}));

meetingsRouter.patch('/:meetingId', requireMeetingManage, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const input = meetingPatchSchema.parse(req.body);
  if (input.scheduledStart && input.scheduledEnd) validateTimes(input.scheduledStart, input.scheduledEnd);
  const updated = await updateLegacyRecord('meetings', meeting.legacyId!, { ...(input.scheduledStart ? { scheduled_start: input.scheduledStart } : {}), ...(input.scheduledEnd ? { scheduled_end: input.scheduledEnd } : {}), ...(input.timezone ? { timezone: input.timezone } : {}), ...(input.title ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description ?? '' } : {}), ...(input.agenda !== undefined ? { agenda: input.agenda ?? '' } : {}), ...(input.internalNotes !== undefined ? { internal_notes: input.internalNotes ?? '' } : {}), updated_at: nowIso() });
  if (!updated) throw new HttpError(404, 'Meeting not found.');
  await writeMeetingActivity('meeting.updated', updated, req.auth!.legacyId);
  res.json({ data: toPublicRecord(updated) });
}));

meetingsRouter.post('/:meetingId/reschedule', requireMeetingManage, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const input = rescheduleSchema.parse(req.body);
  validateTimes(input.scheduledStart, input.scheduledEnd);
  const eventId = String(meeting.raw.google_calendar_event_id ?? '').trim();
  if (!eventId) throw new HttpError(400, 'This meeting has no connected Google Calendar event to reschedule.');
  const updatedEvent = await googleCalendarUpdate(Number(meeting.raw.organizer_id ?? req.auth!.legacyId), eventId, { start: toIso(input.scheduledStart), end: toIso(input.scheduledEnd), timezone: input.timezone ?? String(meeting.raw.timezone ?? 'Asia/Kolkata') });
  const updated = await updateLegacyRecord('meetings', meeting.legacyId!, { scheduled_start: input.scheduledStart, scheduled_end: input.scheduledEnd, timezone: input.timezone ?? meeting.raw.timezone, google_meet_link: extractMeetLink(updatedEvent) ?? meeting.raw.google_meet_link, status: 'scheduled', updated_at: nowIso(), change_history: appendHistory(meeting.raw.change_history, { action: 'rescheduled', by: req.auth!.legacyId, at: nowIso() }) });
  if (!updated) throw new HttpError(404, 'Meeting not found.');
  await writeMeetingActivity('meeting.rescheduled', updated, req.auth!.legacyId);
  await notifyMeetingInvitees(updated, inviteeIds(updated), req.auth!, 'rescheduled');
  emitRealtime('meeting:updated', { meeting: toPublicRecord(updated), action: 'rescheduled' }, 'workforce');
  res.json({ data: toPublicRecord(updated) });
}));

meetingsRouter.post('/:meetingId/cancel', requireMeetingManage, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const input = cancelSchema.parse(req.body);
  const eventId = String(meeting.raw.google_calendar_event_id ?? '').trim();
  if (eventId) await googleCalendarCancel(Number(meeting.raw.organizer_id ?? req.auth!.legacyId), eventId);
  const updated = await updateLegacyRecord('meetings', meeting.legacyId!, { status: 'cancelled', cancellation_reason: input.reason, cancelled_by: req.auth!.legacyId, cancelled_at: nowIso(), updated_at: nowIso(), change_history: appendHistory(meeting.raw.change_history, { action: 'cancelled', by: req.auth!.legacyId, reason: input.reason, at: nowIso() }) });
  if (!updated) throw new HttpError(404, 'Meeting not found.');
  await writeMeetingActivity('meeting.cancelled', updated, req.auth!.legacyId, { reason: input.reason });
  await notifyMeetingInvitees(updated, inviteeIds(updated), req.auth!, 'cancelled');
  emitRealtime('meeting:updated', { meeting: toPublicRecord(updated), action: 'cancelled' }, 'workforce');
  res.json({ data: toPublicRecord(updated) });
}));

meetingsRouter.post('/:meetingId/sync-attendance', requireMeetingAttendance, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const conference = String(meeting.raw.google_conference_record_name ?? meeting.raw.google_meet_code ?? '').trim();
  if (!conference) throw new HttpError(400, 'Google has not published a conference record for this meeting yet.');
  const conferenceRecord = await googleMeetConferenceRecords(Number(meeting.raw.organizer_id ?? req.auth!.legacyId), conference);
  if (!conferenceRecord) throw new HttpError(404, 'The conference record is not ready yet. Try again after the meeting ends.');
  const scheduledEndForSync = timestamp(meeting.raw.scheduled_end);
  if (scheduledEndForSync && Date.now() < scheduledEndForSync) throw new HttpError(400, 'Attendance can be synchronized after the meeting has ended.');
  const recordName = String(conferenceRecord.name ?? '').trim();
  const participants = recordName ? await googleMeetParticipants(Number(meeting.raw.organizer_id ?? req.auth!.legacyId), recordName) : [];
  const scheduledStart = timestamp(meeting.raw.scheduled_start);
  const scheduledEnd = timestamp(meeting.raw.scheduled_end);
  const storedParticipants = await Promise.all(participants.map(async (participant) => {
    const signedIn = participant.signedinUser && typeof participant.signedinUser === 'object' ? participant.signedinUser as Record<string, unknown> : null;
    const participantResource = String(participant.name ?? '').trim();
    let rawSessions: Array<Record<string, unknown>> = [];
    if (participantResource) {
      try { rawSessions = await googleMeetParticipantSessions(Number(meeting.raw.organizer_id ?? req.auth!.legacyId), participantResource); } catch { /* Participant records can briefly appear before their session list. */ }
    }
    const sessions = rawSessions.map((session) => {
      const joinedAt = timestamp(session.startTime ?? session.joinedAt ?? session.join_time);
      const leftAt = timestamp(session.endTime ?? session.leftAt ?? session.leave_time);
      const durationSeconds = joinedAt ? Math.max(0, ((leftAt ?? Date.now()) - joinedAt) / 1_000) : 0;
      return { google_session_resource: session.name ?? null, joined_at: joinedAt ? new Date(joinedAt).toISOString() : null, left_at: leftAt ? new Date(leftAt).toISOString() : null, duration_seconds: Math.round(durationSeconds) };
    });
    const totalDurationSeconds = sessions.reduce((sum, session) => sum + Number(session.duration_seconds ?? 0), 0);
    const firstJoined = sessions.map((session) => timestamp(session.joined_at)).filter((value): value is number => value !== null).sort((a, b) => a - b)[0] ?? null;
    const lastLeft = sessions.map((session) => timestamp(session.left_at)).filter((value): value is number => value !== null).sort((a, b) => b - a)[0] ?? null;
    return { google_participant_resource: participantResource || null, display_name: participant.displayName ?? signedIn?.displayName ?? 'Unidentified guest', email: signedIn?.email ?? null, is_anonymous: !signedIn, was_invited: false, sessions, first_joined_at: firstJoined ? new Date(firstJoined).toISOString() : null, last_left_at: lastLeft ? new Date(lastLeft).toISOString() : null, total_duration_seconds: totalDurationSeconds, rejoin_count: Math.max(0, sessions.length - 1), attendance_status: attendanceStatus({ signedIn: Boolean(signedIn), firstJoined, lastLeft, totalDurationSeconds, scheduledStart, scheduledEnd }) };
  }));
  const invited = Array.isArray(meeting.raw.invitees) ? meeting.raw.invitees as Array<Record<string, unknown>> : [];
  const matchedEmails = new Set(storedParticipants.map((participant) => String(participant.email ?? '').toLowerCase()).filter(Boolean));
  const updatedInvitees: Array<Record<string, unknown>> = invited.map((invitee) => {
    const email = String(invitee.email ?? '').toLowerCase();
    const matched = Boolean(email && matchedEmails.has(email));
    return { ...invitee, attendance_status: matched ? 'attended' : 'absent' };
  });
  const absent = updatedInvitees.filter((invitee) => invitee.attendance_status === 'absent').map((invitee) => ({ crm_user: invitee.crm_user ?? null, display_name: invitee.display_name ?? invitee.email ?? 'Invitee', email: invitee.email ?? null }));
  const updated = await updateLegacyRecord('meetings', meeting.legacyId!, { google_conference_record_name: recordName || null, participants: storedParticipants, invitees: updatedInvitees, absent_invitees: absent, attendance_synced_at: nowIso(), attendance_sync_status: 'completed', status: meeting.raw.status === 'scheduled' ? 'completed' : meeting.raw.status, updated_at: nowIso() });
  if (!updated) throw new HttpError(404, 'Meeting not found.');
  await createLegacyRecord('meeting_attendance_sync_events', { meeting_id: meeting.legacyId, synced_by: req.auth!.legacyId, participant_count: storedParticipants.length, absent_count: absent.length, created_at: nowIso() });
  await writeMeetingActivity('meeting.attendance_synchronized', updated, req.auth!.legacyId, { participant_count: storedParticipants.length, absent_count: absent.length });
  res.json({ data: toPublicRecord(updated), participantCount: storedParticipants.length, absentCount: absent.length });
}));

meetingsRouter.post('/:meetingId/send-notification', meetingMutationRateLimit, requireMeetingManage, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  if (!String(meeting.raw.google_meet_link ?? '').trim()) throw new HttpError(400, 'A valid Google Meet link is required before sending invitations.');
  await notifyMeetingInvitees(meeting, inviteeIds(meeting), req.auth!, 'reminder');
  await writeMeetingActivity('meeting.notification_sent', meeting, req.auth!.legacyId);
  res.status(204).send();
}));

meetingsRouter.post('/:meetingId/participants/:participantId/link', requireMeetingAttendance, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const participantIndex = Number(req.params.participantId);
  if (!Number.isSafeInteger(participantIndex) || participantIndex < 0) throw new HttpError(400, 'Invalid participant ID.');
  const participants = Array.isArray(meeting.raw.participants) ? [...meeting.raw.participants] as Array<Record<string, unknown>> : [];
  if (!participants[participantIndex]) throw new HttpError(404, 'Participant not found.');
  const input = linkParticipantSchema.parse(req.body);
  participants[participantIndex] = { ...participants[participantIndex], crm_user: input.userId ?? null, client: input.clientId ?? null, was_invited: true, attendance_status: 'attended' };
  const updated = await updateLegacyRecord('meetings', meeting.legacyId!, { participants, updated_at: nowIso() });
  if (!updated) throw new HttpError(404, 'Meeting not found.');
  await writeMeetingActivity('meeting.participant_linked', updated, req.auth!.legacyId);
  res.json({ data: toPublicRecord(updated) });
}));

meetingsRouter.delete('/:meetingId', requireMeetingManage, asyncHandler(async (req, res) => {
  const meeting = await visibleMeeting(req, idParam(req.params.meetingId));
  const archived = await archiveLegacyRecord('meetings', meeting.legacyId!);
  if (!archived) throw new HttpError(404, 'Meeting not found.');
  await writeMeetingActivity('meeting.archived', meeting, req.auth!.legacyId);
  res.status(204).send();
}));

async function listMeetingRecords(req: Request, options: { upcoming?: boolean } = {}) {
  const all = isCompanyMeetingReader(req.auth!) ? undefined : meetingVisibilityScope(req.auth!.legacyId);
  const filters: Record<string, string | number | boolean | null> = {};
  const status = stringQuery(req.query.status);
  if (status && meetingStatuses.includes(status as typeof meetingStatuses[number])) filters.status = status;
  const result = await listLegacyRecords('meetings', { page: numberQuery(req.query.page, 1), limit: Math.min(50, numberQuery(req.query.limit, 10)), search: stringQuery(req.query.search), searchFields: ['title', 'description', 'status'], filters, sort: 'scheduled_start', order: options.upcoming ? 'asc' : 'desc', scope: all });
  if (!options.upcoming) return result;
  const today = Date.now();
  return { ...result, data: result.data.filter((record) => { const time = new Date(String(record.fields.scheduled_start ?? '')).getTime(); return Number.isFinite(time) && time >= today; }) };
}

async function visibleMeeting(req: Request, id: number): Promise<LegacyRecord> {
  const meeting = await findLegacyRecord('meetings', id);
  if (!meeting || (!isCompanyMeetingReader(req.auth!) && !meetingVisibleTo(meeting, req.auth!.legacyId))) throw new HttpError(404, 'Meeting not found.');
  return meeting;
}

/** Google creates conference data asynchronously. Detail-page polling calls
 * this lightweight hydrator so a meeting that initially returned 202 receives
 * its real Meet URL without requiring a manual reschedule. Provider failures
 * are intentionally swallowed here; the original meeting remains visible and
 * the next poll or an explicit action can retry it. */
async function hydratePendingMeeting(meeting: LegacyRecord): Promise<LegacyRecord> {
  if (String(meeting.raw.status ?? '') !== 'creating') return meeting;
  const eventId = String(meeting.raw.google_calendar_event_id ?? '').trim();
  const organizerId = Number(meeting.raw.organizer_id);
  if (!eventId || !Number.isSafeInteger(organizerId) || organizerId <= 0) return meeting;
  try {
    const event = await googleCalendarGet(organizerId, eventId);
    const link = extractMeetLink(event);
    const conferenceStatus = String(event.conferenceData?.createRequest?.status?.statusCode ?? '').toLowerCase();
    if (!link && conferenceStatus !== 'failure') return meeting;
    const updated = await updateLegacyRecord('meetings', meeting.legacyId!, {
      google_meet_link: link,
      google_meet_code: event.conferenceData?.conferenceId ?? meeting.raw.google_meet_code ?? null,
      status: link ? 'scheduled' : 'failed',
      ...(link ? {} : { google_meet_error: 'Google could not generate a Meet conference for this Calendar event. Reconnect the organizer account and reschedule the meeting.' }),
      updated_at: nowIso()
    });
    return updated ?? meeting;
  } catch {
    return meeting;
  }
}

function requireMeetingRead(req: Request, res: Response, next: NextFunction): void { if (!req.auth || (!isCompanyMeetingReader(req.auth) && !can(req.auth, 'meetings.view') && !isEmployeeMeetingViewer(req.auth))) { res.status(403).json({ error: 'You do not have permission to view meetings.' }); return; } next(); }
function requireMeetingCreate(req: Request, res: Response, next: NextFunction): void { if (!req.auth || (!isCompanyMeetingManager(req.auth) && !can(req.auth, 'meetings.create'))) { res.status(403).json({ error: 'You do not have permission to schedule meetings.' }); return; } next(); }
function requireMeetingManage(req: Request, res: Response, next: NextFunction): void { if (!req.auth || (!isCompanyMeetingManager(req.auth) && !can(req.auth, 'meetings.update'))) { res.status(403).json({ error: 'You do not have permission to manage this meeting.' }); return; } next(); }
function requireMeetingAttendance(req: Request, res: Response, next: NextFunction): void { if (!req.auth || (!isCompanyMeetingReader(req.auth) && !can(req.auth, 'meetings.viewAttendance'))) { res.status(403).json({ error: 'You do not have permission to view meeting attendance.' }); return; } next(); }
function requireIntegrationManage(req: Request, res: Response, next: NextFunction): void { if (!req.auth || (!isCompanyMeetingManager(req.auth) && !can(req.auth, 'meetings.manageIntegrations'))) { res.status(403).json({ error: 'You do not have permission to manage Google Calendar integration.' }); return; } next(); }
function isCompanyMeetingReader(auth: AuthContext): boolean { return Boolean(auth.permissions.includes('*') || isCeoRole(auth) || isAdminOrHrRole(auth)); }
function isCompanyMeetingManager(auth: AuthContext): boolean { return Boolean(auth.permissions.includes('*') || isCeoRole(auth) || isAdminOrHrRole(auth)); }
function isEmployeeMeetingViewer(auth: AuthContext): boolean { return auth.role.trim().toLowerCase() === 'employee'; }
function meetingVisibleTo(record: LegacyRecord, userId: number): boolean { const raw = record.raw; const invitees = Array.isArray(raw.invitees) ? raw.invitees : []; return [raw.organizer_id, raw.created_by, raw.user_id, ...(Array.isArray(raw.invitee_ids) ? raw.invitee_ids : []), ...invitees.flatMap((entry) => entry && typeof entry === 'object' ? [((entry as Record<string, unknown>).crm_user ?? (entry as Record<string, unknown>).user_id)] : [])].some((value) => Number(value) === userId); }
function meetingVisibilityScope(userId: number) { return { $or: [{ 'raw.organizer_id': userId }, { 'raw.created_by': userId }, { 'raw.user_id': userId }, { 'raw.invitee_ids': userId }, { 'raw.invitees.crm_user': userId }, { 'raw.invitees.user_id': userId }] }; }
async function notifyMeetingInvitees(meeting: LegacyRecord, userIds: number[], actor: AuthContext, action: 'scheduled' | 'rescheduled' | 'cancelled' | 'reminder'): Promise<void> { const unique = [...new Set(userIds)].filter((id) => id > 0 && id !== actor.legacyId); const title = `Meeting ${action}: ${String(meeting.raw.title ?? 'meeting')}`; await Promise.all(unique.map(async (userId) => { const notification = await createLegacyRecord('notifications', { user_id: userId, title, body: `${actor.name} ${action} the meeting. ${String(meeting.raw.google_meet_link ?? '')}`.trim(), type: 'meeting', priority: action === 'cancelled' ? 'high' : 'normal', url: `/data/meetings/${meeting.legacyId}`, is_read: 0, created_at: nowIso() }); emitRealtime('notification:new', { notification: toPublicRecord(notification) }, `user:${userId}`); })); }
function inviteeIds(meeting: LegacyRecord): number[] { return Array.isArray(meeting.raw.invitees) ? meeting.raw.invitees.flatMap((entry) => entry && typeof entry === 'object' ? [Number((entry as Record<string, unknown>).crm_user)] : []).filter(isPositive) : []; }
function appendHistory(value: unknown, event: Record<string, unknown>): Array<Record<string, unknown>> { return [...(Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')) : []), event]; }
function validateTimes(start: string, end: string): void { const from = new Date(start).getTime(); const to = new Date(end).getTime(); if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'Meeting end time must be later than its start time.'); }
function toIso(value: string): string { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) throw new HttpError(400, 'Use a valid meeting date and time.'); return parsed.toISOString(); }
function safeOrigin(): string {
  const configured = [env.APP_ORIGIN, env.CORS_ORIGIN].filter((value): value is string => Boolean(value)).flatMap((value) => value.split(','));
  for (const value of configured) {
    try {
      const parsed = new URL(value.trim());
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && (parsed.pathname === '/' || parsed.pathname === '')) return parsed.origin;
    } catch { /* try the next configured origin */ }
  }
  return env.NODE_ENV === 'production' ? 'https://www.kakicrm.store' : 'http://localhost:5173';
}
function idParam(value: string | string[] | undefined): number { const parsed = Number(Array.isArray(value) ? value[0] : value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid meeting ID.'); return parsed; }
function numberQuery(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
function stringQuery(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function isPositive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function nowIso(): string { return new Date().toISOString(); }
function wait(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function timestamp(value: unknown): number | null {
  if (value instanceof Date) return value.valueOf();
  const parsed = new Date(String(value ?? '')).valueOf();
  return Number.isFinite(parsed) ? parsed : null;
}
function attendanceStatus(input: { signedIn: boolean; firstJoined: number | null; lastLeft: number | null; totalDurationSeconds: number; scheduledStart: number | null; scheduledEnd: number | null }): 'attended' | 'late' | 'left_early' | 'partial' | 'unidentified_guest' {
  if (!input.signedIn) return 'unidentified_guest';
  if (!input.firstJoined) return 'partial';
  const lateAfter = (env.MEETING_LATE_AFTER_MINUTES ?? 10) * 60_000;
  const leftEarlyBefore = (env.MEETING_LEFT_EARLY_BEFORE_MINUTES ?? 10) * 60_000;
  const minimumPercent = env.MEETING_MINIMUM_ATTENDANCE_PERCENT ?? 50;
  if (input.scheduledStart && input.firstJoined > input.scheduledStart + lateAfter) return 'late';
  if (input.scheduledEnd && input.lastLeft && input.lastLeft < input.scheduledEnd - leftEarlyBefore) return 'left_early';
  if (input.scheduledStart && input.scheduledEnd && input.scheduledEnd > input.scheduledStart) {
    const plannedSeconds = (input.scheduledEnd - input.scheduledStart) / 1_000;
    if (plannedSeconds > 0 && (input.totalDurationSeconds / plannedSeconds) * 100 < minimumPercent) return 'partial';
  }
  return 'attended';
}
async function writeMeetingActivity(action: string, meeting: LegacyRecord, actorId: number, extra: Record<string, unknown> = {}): Promise<void> {
  await createLegacyRecord('activity_logs', {
    action,
    event: action,
    entity_type: 'meeting',
    entity_id: meeting.legacyId ?? null,
    meeting_id: meeting.legacyId ?? null,
    actor_id: actorId,
    message: `${action.replaceAll('.', ' ')}: ${String(meeting.raw.title ?? 'Meeting')}`,
    ...extra,
    created_at: nowIso()
  });
}

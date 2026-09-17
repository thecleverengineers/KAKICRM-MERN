import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../config/env.js';
import { emitRealtime } from '../realtime.js';
import { createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { asyncHandler, HttpError } from '../utils/http.js';

/**
 * Provider callbacks intentionally live outside the bearer-authenticated CRM
 * routes. They accept only a minimised event envelope, verify a deployment
 * token, and persist an idempotency key before touching a meeting. Configure
 * an authenticated Google Pub/Sub push subscription in production; the shared
 * token is an additional boundary for installations that expose a direct
 * callback URL.
 */
export const webhooksRouter = Router();

webhooksRouter.get('/whatsapp', (req, res) => {
  const expected = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const mode = queryText(req.query['hub.mode']);
  const token = queryText(req.query['hub.verify_token']);
  const challenge = queryText(req.query['hub.challenge']);
  if (!expected || mode !== 'subscribe' || token !== expected || !challenge) {
    res.status(403).send('Webhook verification failed.');
    return;
  }
  res.type('text/plain').send(challenge);
});

webhooksRouter.post('/google-workspace', asyncHandler(async (req, res) => {
  verifyProviderToken(req, env.GOOGLE_WORKSPACE_WEBHOOK_TOKEN, 'Google Workspace');
  const envelope = decodeGooglePush(req.body);
  const duplicate = await listRawRecords('meeting_webhook_events', { 'raw.event_id': envelope.eventId }, 1);
  if (duplicate.length) {
    res.status(204).send();
    return;
  }

  const receivedAt = nowIso();
  await createLegacyRecord('meeting_webhook_events', {
    event_id: envelope.eventId,
    provider: 'google_workspace',
    event_type: envelope.eventType,
    resource_name: envelope.resourceName,
    meeting_id: envelope.meetingId,
    event_time: envelope.eventTime,
    received_at: receivedAt
  });

  const meeting = await findMeeting(envelope.meetingId, envelope.resourceName);
  if (meeting?.legacyId) {
    const status = meetingStatusForEvent(envelope.eventType);
    const fields: Record<string, unknown> = {
      last_workspace_event_id: envelope.eventId,
      last_workspace_event_at: envelope.eventTime ?? receivedAt,
      updated_at: receivedAt
    };
    if (status) fields.status = status;
    if (/started|start/i.test(envelope.eventType)) fields.actual_start = envelope.eventTime ?? receivedAt;
    if (/ended|end/i.test(envelope.eventType)) {
      fields.actual_end = envelope.eventTime ?? receivedAt;
      fields.attendance_sync_status = 'pending';
    } else if (/participant|recording|transcript/i.test(envelope.eventType)) {
      fields.attendance_sync_status = 'pending';
    }
    const updated = await updateLegacyRecord('meetings', meeting.legacyId, fields);
    if (updated) emitRealtime('meeting:event', { meetingId: updated.legacyId, eventType: envelope.eventType }, 'workforce');
  }
  // Pub/Sub push handlers should acknowledge quickly. Attendance remains a
  // separate authoritative fetch from Google, initiated by the sync worker or
  // the authorised “Sync attendance” control.
  res.status(204).send();
}));

webhooksRouter.post('/whatsapp', asyncHandler(async (req, res) => {
  verifyProviderToken(req, env.WHATSAPP_WEBHOOK_VERIFY_TOKEN, 'WhatsApp');
  const events = whatsappStatusEvents(req.body);
  const fallbackEvent = events.length ? events : [{
    eventId: stableEventId('whatsapp', req.body),
    messageId: null,
    recipient: null,
    status: 'received',
    timestamp: null,
    meetingId: null
  }];

  for (const event of fallbackEvent) {
    const duplicate = await listRawRecords('meeting_notification_events', { 'raw.event_id': event.eventId }, 1);
    if (duplicate.length) continue;
    await createLegacyRecord('meeting_notification_events', {
      event_id: event.eventId,
      provider: 'whatsapp',
      message_id: event.messageId,
      recipient: event.recipient,
      status: event.status,
      event_time: event.timestamp,
      meeting_id: event.meetingId,
      received_at: nowIso()
    });

    const meeting = await findMeeting(event.meetingId, event.messageId);
    if (meeting?.legacyId) {
      const current = Array.isArray(meeting.raw.whatsapp_delivery_events) ? meeting.raw.whatsapp_delivery_events : [];
      const updated = await updateLegacyRecord('meetings', meeting.legacyId, {
        whatsapp_delivery_events: [...current, { event_id: event.eventId, message_id: event.messageId, recipient: event.recipient, status: event.status, event_time: event.timestamp }].slice(-100),
        whatsapp_delivery_status: event.status,
        updated_at: nowIso()
      });
      if (updated) emitRealtime('meeting:delivery', { meetingId: updated.legacyId, status: event.status }, 'workforce');
    }
  }
  res.status(204).send();
}));

interface GoogleWebhookEnvelope {
  eventId: string;
  eventType: string;
  resourceName: string | null;
  meetingId: number | null;
  eventTime: string | null;
}

interface WhatsAppStatusEvent {
  eventId: string;
  messageId: string | null;
  recipient: string | null;
  status: string;
  timestamp: string | null;
  meetingId: number | null;
}

function verifyProviderToken(req: Request, expected: string | undefined, provider: string): void {
  if (!expected) throw new HttpError(503, `${provider} webhook is not configured.`);
  const supplied = String(req.headers['x-kaki-webhook-token'] ?? req.headers['x-provider-webhook-token'] ?? '').trim();
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (!supplied || expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    throw new HttpError(401, `${provider} webhook verification failed.`);
  }
}

function decodeGooglePush(body: unknown): GoogleWebhookEnvelope {
  const root = objectValue(body);
  const message = objectValue(root.message);
  const encoded = typeof message.data === 'string' ? message.data : null;
  const decoded = encoded ? parseJson(Buffer.from(encoded, 'base64').toString('utf8')) : null;
  const event = objectValue(decoded ?? root);
  const eventId = firstText(message.messageId, root.eventId, root.id) ?? stableEventId('google', body);
  const eventType = firstText(event.eventType, event.type, event.event, root.eventType, root.type) ?? 'workspace_event';
  const resourceName = firstText(event.resourceName, event.resource, event.name, objectValue(event.conferenceRecord).name, objectValue(event.participant).name);
  return {
    eventId,
    eventType,
    resourceName: resourceName ?? null,
    meetingId: positiveNumber(event.meetingId ?? event.meeting_id ?? root.meetingId),
    eventTime: firstText(event.eventTime, event.timestamp, event.occurredAt, root.eventTime) ?? null
  };
}

function whatsappStatusEvents(body: unknown): WhatsAppStatusEvent[] {
  const root = objectValue(body);
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const events: WhatsAppStatusEvent[] = [];
  for (const entryValue of entries) {
    const entry = objectValue(entryValue);
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const changeValue of changes) {
      const change = objectValue(changeValue);
      const value = objectValue(change.value);
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const statusValue of statuses) {
        const status = objectValue(statusValue);
        const messageId = firstText(status.id);
        const recipient = firstText(status.recipient_id);
        const timestamp = firstText(status.timestamp);
        const eventId = messageId ? `${messageId}:${firstText(status.status) ?? 'unknown'}:${timestamp ?? ''}` : stableEventId('whatsapp-status', status);
        events.push({ eventId, messageId: messageId ?? null, recipient: recipient ?? null, status: firstText(status.status) ?? 'unknown', timestamp: timestamp ?? null, meetingId: positiveNumber(status.meeting_id ?? value.meeting_id) });
      }
    }
  }
  return events;
}

async function findMeeting(meetingId: number | null, resourceName: string | null): Promise<Awaited<ReturnType<typeof findLegacyRecord>>> {
  if (meetingId) return findLegacyRecord('meetings', meetingId);
  if (!resourceName) return null;
  const [meeting] = await listRawRecords('meetings', {
    $or: [
      { 'raw.google_conference_record_name': resourceName },
      { 'raw.google_meet_code': resourceName },
      { 'raw.google_calendar_event_id': resourceName },
      { 'raw.whatsapp_message_id': resourceName }
    ]
  }, 1);
  return meeting ?? null;
}

function meetingStatusForEvent(eventType: string): 'in_progress' | 'completed' | undefined {
  if (/conference[_ .-]?started|meeting[_ .-]?started|participant[_ .-]?joined/i.test(eventType)) return 'in_progress';
  if (/conference[_ .-]?ended|meeting[_ .-]?ended/i.test(eventType)) return 'completed';
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: string): Record<string, unknown> | null {
  try { return objectValue(JSON.parse(value)); } catch { return null; }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function positiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function stableEventId(prefix: string, value: unknown): string {
  return `${prefix}:${crypto.createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')}`;
}

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nowIso(): string { return new Date().toISOString(); }

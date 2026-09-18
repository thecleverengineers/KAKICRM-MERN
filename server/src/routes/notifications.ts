import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { findLegacyRecord, listLegacyRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { removeBrowserPushSubscription, saveBrowserPushSubscription, webPushStatus, type BrowserPushSubscription } from '../services/webPush.js';
import { toPublicRecord } from '../db/legacy.js';
import { asyncHandler, HttpError } from '../utils/http.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/push/status', asyncHandler(async (_req, res) => {
  res.json({ data: webPushStatus() });
}));

notificationsRouter.post('/push/subscription', asyncHandler(async (req, res) => {
  await saveBrowserPushSubscription(req.auth!.legacyId, readSubscription(req.body));
  res.status(201).json({ data: { subscribed: true } });
}));

notificationsRouter.delete('/push/subscription', asyncHandler(async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? '').trim();
  if (!endpoint || endpoint.length > 4_000) throw new HttpError(400, 'A valid browser push endpoint is required.');
  await removeBrowserPushSubscription(req.auth!.legacyId, endpoint);
  res.status(204).send();
}));

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('notifications', {
    page: numberQuery(req.query.page, 1),
    limit: numberQuery(req.query.limit, 50),
    filters: { user_id: req.auth!.legacyId },
    sort: 'created_at',
    order: 'desc'
  });
  const unread = result.data.filter((item) => !Number(item.fields.is_read)).length;
  res.json({ ...result, unread });
}));

notificationsRouter.patch('/:notificationId/read', asyncHandler(async (req, res) => {
  const id = identifier(req.params.notificationId);
  const notification = await findLegacyRecord('notifications', id);
  if (!notification || Number(notification.raw.user_id) !== req.auth!.legacyId) throw new HttpError(404, 'Notification not found.');
  const updated = await updateLegacyRecord('notifications', id, { is_read: 1, read_at: nowIst() });
  res.json({ data: updated ? toPublicRecord(updated) : null });
}));

notificationsRouter.post('/mark-all-read', asyncHandler(async (req, res) => {
  const { listRawRecords } = await import('../services/legacyRepository.js');
  const notifications = await listRawRecords('notifications', { 'raw.user_id': req.auth!.legacyId, 'raw.is_read': { $ne: 1 } }, 1_000);
  await Promise.all(notifications.map((notification) => updateLegacyRecord('notifications', notification.legacyId!, { is_read: 1, read_at: nowIst() })));
  res.status(204).send();
}));

function identifier(value: string | string[] | undefined): number {
  const number = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, 'Invalid notification ID.');
  return number;
}

function numberQuery(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

function readSubscription(value: unknown): BrowserPushSubscription {
  const body = value as { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(body?.endpoint ?? '').trim();
  const p256dh = String(body?.keys?.p256dh ?? '').trim();
  const auth = String(body?.keys?.auth ?? '').trim();
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 4_000 || !p256dh || !auth) {
    throw new HttpError(400, 'Invalid browser push subscription.');
  }
  const expiration = Number(body.expirationTime);
  return { endpoint, expirationTime: Number.isFinite(expiration) ? expiration : null, keys: { p256dh, auth } };
}

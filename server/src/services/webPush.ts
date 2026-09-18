import webpush from 'web-push';
import { env } from '../config/env.js';
import { archiveLegacyRecord, createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
}

function configured(): boolean {
  return Boolean(env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY);
}

if (configured()) {
  webpush.setVapidDetails(env.PUSH_VAPID_SUBJECT, env.PUSH_VAPID_PUBLIC_KEY!, env.PUSH_VAPID_PRIVATE_KEY!);
}

export function webPushStatus(): { configured: boolean; publicKey: string | null } {
  return { configured: configured(), publicKey: env.PUSH_VAPID_PUBLIC_KEY ?? null };
}

export async function saveBrowserPushSubscription(userId: number, subscription: BrowserPushSubscription): Promise<void> {
  const [existing] = await listRawRecords('push_subscriptions', { 'raw.user_id': userId, 'raw.endpoint': subscription.endpoint }, 1);
  const fields = {
    user_id: userId,
    endpoint: subscription.endpoint,
    expiration_time: subscription.expirationTime ?? null,
    key_p256dh: subscription.keys.p256dh,
    key_auth: subscription.keys.auth,
    user_agent: null,
    updated_at: nowIso(),
    active: 1
  };
  if (existing?.legacyId) {
    await updateLegacyRecord('push_subscriptions', existing.legacyId, fields);
    return;
  }
  await createLegacyRecord('push_subscriptions', { ...fields, created_at: nowIso() });
}

export async function removeBrowserPushSubscription(userId: number, endpoint: string): Promise<void> {
  const [existing] = await listRawRecords('push_subscriptions', { 'raw.user_id': userId, 'raw.endpoint': endpoint }, 1);
  if (existing?.legacyId) await archiveLegacyRecord('push_subscriptions', existing.legacyId);
}

export async function sendWebPushToUser(userId: number, payload: PushNotificationPayload): Promise<void> {
  if (!configured()) return;
  const subscriptions = await listRawRecords('push_subscriptions', { 'raw.user_id': userId, 'raw.active': 1 }, 50);
  await Promise.all(subscriptions.map(async (record) => {
    const endpoint = String(record.raw.endpoint ?? '').trim();
    const p256dh = String(record.raw.key_p256dh ?? '').trim();
    const auth = String(record.raw.key_auth ?? '').trim();
    if (!endpoint || !p256dh || !auth) return;
    try {
      await webpush.sendNotification({ endpoint, expirationTime: null, keys: { p256dh, auth } }, JSON.stringify({
        ...payload,
        url: payload.url ?? '/notifications',
        icon: payload.icon ?? '/favicon.ico',
        badge: '/favicon.ico'
      }));
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode);
      if ((statusCode === 404 || statusCode === 410) && record.legacyId) {
        await archiveLegacyRecord('push_subscriptions', record.legacyId).catch(() => undefined);
      } else {
        console.warn('[KAKI CRM] Browser push delivery failed.', error);
      }
    }
  }));
}

export async function sendWebPushForNotification(fields: Record<string, unknown>): Promise<void> {
  const userId = Number(fields.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  await sendWebPushToUser(userId, {
    title: String(fields.title ?? 'KAKI CRM notification'),
    body: String(fields.body ?? 'You have a new notification.'),
    url: String(fields.url ?? '/notifications'),
    tag: `kaki-notification-${String(fields.type ?? 'general')}`
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

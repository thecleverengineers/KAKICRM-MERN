import { api } from './api.js';

export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
}

export function supportsBrowserPush(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function readPushStatus(): Promise<PushStatus> {
  return (await api<{ data: PushStatus }>('/notifications/push/status')).data;
}

export async function readBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (!supportsBrowserPush()) return null;
  const registration = await navigator.serviceWorker.register('/push-sw.js');
  return registration.pushManager.getSubscription();
}

export async function enableBrowserPush(publicKey: string): Promise<void> {
  if (!supportsBrowserPush()) throw new Error('This browser does not support web push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Browser notifications are blocked. Allow them in site permissions, then try again.' : 'Browser notification permission was not granted.');
  const registration = await navigator.serviceWorker.register('/push-sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(publicKey) });
  await api('/notifications/push/subscription', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
}

export async function disableBrowserPush(): Promise<void> {
  if (!supportsBrowserPush()) return;
  const subscription = await readBrowserPushSubscription();
  if (!subscription) return;
  await api('/notifications/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

function decodeVapidKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

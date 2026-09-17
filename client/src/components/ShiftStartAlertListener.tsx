import { useEffect, useRef, useState } from 'react';
import { BellRing, ExternalLink, Volume2, X } from 'lucide-react';
import { io } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import { getAccessToken } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

interface LiveNotificationAlert {
  id: string;
  kind: 'attendance' | 'task' | 'notification';
  title: string;
  body: string;
  url: string;
  employeeName?: string;
  startedAt?: string | null;
}

interface ShiftStartAlertListenerProps {
  onOpenWorkforce: () => void;
}

/**
 * Keeps task, workspace, and attendance alerts live throughout the CRM rather
 * than only while a particular page is open. The browser/OS decides which
 * installed female voice is available; a friendly English fallback is used.
 */
export function ShiftStartAlertListener({ onOpenWorkforce }: ShiftStartAlertListenerProps) {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [alert, setAlert] = useState<LiveNotificationAlert | null>(null);
  const handledAlertIds = useRef(new Set<string>());
  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const receivesWorkforceAlerts = Boolean(user && (hasPermission('attendance.view') || hasPermission('attendance.manage') || isAdminOrHr(user.role)));
  const receivesLiveNotifications = Boolean(user);

  useEffect(() => {
    if (!canSpeak()) return undefined;
    const synthesis = window.speechSynthesis;
    const refreshVoices = () => { voices.current = synthesis.getVoices(); };
    const resumeSpeech = () => synthesis.resume();
    refreshVoices();
    synthesis.addEventListener('voiceschanged', refreshVoices);
    window.addEventListener('pointerdown', resumeSpeech, { capture: true });
    window.addEventListener('keydown', resumeSpeech, { capture: true });
    return () => {
      synthesis.removeEventListener('voiceschanged', refreshVoices);
      window.removeEventListener('pointerdown', resumeSpeech, { capture: true });
      window.removeEventListener('keydown', resumeSpeech, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (!receivesLiveNotifications) return undefined;
    const token = getAccessToken();
    if (!token) return undefined;

    const socket = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    const receiveAlert = (payload: unknown) => {
      const next = readLiveNotification(payload, receivesWorkforceAlerts);
      if (!next || handledAlertIds.current.has(next.id)) return;
      if (handledAlertIds.current.size >= 100) handledAlertIds.current.clear();
      handledAlertIds.current.add(next.id);
      setAlert(next);
      speakLiveNotification(next, voices.current);
    };

    socket.on('notification:new', receiveAlert);
    return () => { socket.disconnect(); };
  }, [receivesLiveNotifications, receivesWorkforceAlerts, user?.recordId]);

  useEffect(() => {
    if (!alert) return undefined;
    const timeout = window.setTimeout(() => setAlert(null), 14_000);
    return () => window.clearTimeout(timeout);
  }, [alert]);

  if (!alert) return null;
  const attendance = alert.kind === 'attendance';
  const startedAt = displayTime(alert.startedAt ?? null);

  return <section className={`shift-start-alert${attendance ? '' : ' shift-start-alert--notification'}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="shift-start-alert__icon"><BellRing size={20} /></span>
    <div className="shift-start-alert__copy">
      <p>{attendance ? 'Live attendance' : alert.kind === 'task' ? 'Task notification' : 'New notification'}</p>
      <strong>{attendance ? `${alert.employeeName ?? 'An employee'} started their shift` : alert.title}</strong>
      <span>{attendance ? (startedAt ? `Started at ${startedAt}` : 'Shift start recorded just now') : alert.body}</span>
      <div className="shift-start-alert__actions">
        <button type="button" onClick={() => speakLiveNotification(alert, voices.current)}><Volume2 size={15} /> Hear alert</button>
        <button type="button" onClick={() => attendance ? onOpenWorkforce() : navigate(alert.url)}><ExternalLink size={14} /> {attendance ? 'View workforce' : 'Open notification'}</button>
      </div>
    </div>
    <button className="icon-button shift-start-alert__close" type="button" onClick={() => setAlert(null)} aria-label="Dismiss shift-start alert"><X size={17} /></button>
  </section>;
}

function readLiveNotification(payload: unknown, canReadAttendance: boolean): LiveNotificationAlert | null {
  const event = record(payload);
  const notification = record(event?.notification) ?? event;
  const fields = record(notification?.fields);
  if (!fields) return null;
  const alert = record(event?.alert);
  const type = text(fields.type) ?? text(alert?.type) ?? 'notification';
  const notificationId = text(notification?.legacyId) ?? text(notification?.id) ?? `${type}:${text(fields.created_at) ?? Date.now()}`;

  if (type === 'attendance.shift_started') {
    if (!canReadAttendance) return null;
    const employeeName = text(alert?.employeeName) ?? text(fields.employee_name) ?? 'An employee';
    const startedAt = text(alert?.startedAt) ?? text(fields.started_at) ?? null;
    return {
      id: notificationId,
      kind: 'attendance',
      title: `${employeeName} started their shift`,
      body: startedAt ? `Shift started at ${displayTime(startedAt) ?? startedAt}.` : 'Shift start recorded just now.',
      url: '/workforce',
      employeeName,
      startedAt
    };
  }

  const title = text(fields.title) ?? 'New notification';
  const body = text(fields.body) ?? 'You have a new notification.';
  const url = internalUrl(text(fields.url)) ?? '/notifications';
  return { id: notificationId, kind: type.startsWith('task.') ? 'task' : 'notification', title, body, url };
}

function speakLiveNotification(alert: LiveNotificationAlert, voices: SpeechSynthesisVoice[]): void {
  if (!canSpeak()) return;
  const body = alert.body.length > 260 ? `${alert.body.slice(0, 257)}…` : alert.body;
  const utterance = new SpeechSynthesisUtterance(`Hello. ${alert.title}. ${body}`);
  const voice = preferredFemaleVoice(voices);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = 'en-IN';
  }
  utterance.rate = 0.93;
  utterance.pitch = 1.12;
  utterance.volume = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function internalUrl(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith('/') ? value : null;
}

function preferredFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const englishVoices = voices.filter((voice) => /^en(?:[-_]|$)/i.test(voice.lang));
  const candidates = englishVoices.length ? englishVoices : voices;
  const femaleName = /female|clara|zira|samantha|victoria|karen|moira|tessa|veena|heera|raveena|susan|hazel|linda|aria|jenny|sonia|natasha|ava|emma|olivia/i;
  return candidates.find((voice) => femaleName.test(voice.name))
    ?? candidates.find((voice) => voice.localService)
    ?? candidates[0];
}

function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function isAdminOrHr(role: string): boolean {
  const normalized = role.trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
  return normalized === 'admin'
    || normalized === 'administrator'
    || normalized.startsWith('admin ')
    || normalized === 'hr'
    || normalized.startsWith('hr ')
    || normalized.includes('human resource');
}

function displayTime(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(?:\s|T)(\d{2}):(\d{2})/);
  if (!match) return value;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour)) return `${match[1]}:${match[2]} IST`;
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'pm' : 'am'} IST`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

import type { LegacyRecord } from '../db/legacy.js';
import { readFast2SmsWhatsAppConfiguration, type Fast2SmsWhatsAppConfiguration } from './fast2smsSettings.js';
import { readSavedWhatsAppNumber } from './permissions.js';
import { findLegacyRecord } from './legacyRepository.js';

interface TaskAssignmentWhatsAppInput {
  task: LegacyRecord;
  assigneeIds: number[];
  assignedById: number;
  assignedByName: string;
}

/**
 * Delivers Fast2SMS's approved `my_task` WhatsApp template only to people
 * newly assigned to a task. A provider outage or missing setup never blocks
 * task creation.
 */
export async function notifyTaskAssigneesOnWhatsApp(input: TaskAssignmentWhatsAppInput): Promise<void> {
  const recipients = [...new Set(input.assigneeIds)]
    .filter((userId) => Number.isSafeInteger(userId) && userId > 0 && userId !== input.assignedById);
  if (!recipients.length) return;

  try {
    const configuration = await readFast2SmsWhatsAppConfiguration();
    if (!configuration) return;
    const taskValues = taskTemplateValues(input.task, input.assignedByName);
    const results = await Promise.all(recipients.map(async (userId) => {
      const user = await findLegacyRecord('users', userId);
      if (!user || !isActive(user.raw.status)) return { userId, sent: false, reason: 'inactive or missing user' };

      const recipientNumber = readSavedWhatsAppNumber(user.raw);
      if (!recipientNumber) return { userId, sent: false, reason: 'missing WhatsApp number' };

      await sendTemplateMessage(configuration, recipientNumber, taskValues);
      return { userId, sent: true };
    }));

    for (const result of results) {
      if (!result.sent && result.reason !== 'missing WhatsApp number') {
        console.warn(`[KAKI CRM] Task WhatsApp notification skipped for user #${result.userId}: ${result.reason}.`);
      }
    }
  } catch (error) {
    // The task and its CRM notification have already been stored. Keep the
    // external delivery failure visible in PM2 logs without failing the task.
    console.error('[KAKI CRM] Task WhatsApp notification delivery failed.', error instanceof Error ? error.message : error);
  }
}

function taskTemplateValues(task: LegacyRecord, assignedByName: string): string[] {
  return [
    textValue(assignedByName, 'A team member', 180),
    textValue(task.raw.title, 'Untitled task', 255),
    textValue(task.raw.description, 'No description provided.', 900),
    humanize(textValue(task.raw.status, 'pending', 50)),
    humanize(textValue(task.raw.priority, 'normal', 50)),
    textValue(task.raw.due_date, 'No due date', 80)
  ];
}

async function sendTemplateMessage(configuration: Fast2SmsWhatsAppConfiguration, recipientNumber: string, values: string[]): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    // Exact Fast2SMS WhatsApp contract for approved message_id 30840:
    // authorization, message_id, phone_number_id, numbers, variables_values.
    const url = new URL(configuration.apiUrl);
    url.searchParams.set('authorization', configuration.apiKey);
    url.searchParams.set('message_id', configuration.messageId);
    url.searchParams.set('phone_number_id', configuration.phoneNumberId);
    url.searchParams.set('numbers', fast2SmsNumber(recipientNumber));
    url.searchParams.set('variables_values', values.join('|'));

    const response = await fetch(url, { method: 'GET', signal: controller.signal });

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(payload?.message || `Fast2SMS WhatsApp API returned HTTP ${response.status}.`);
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (payload && (payload.return === false || String(payload.status ?? '').toLowerCase() === 'false')) {
      throw new Error(String(payload.message ?? 'Fast2SMS did not accept the WhatsApp message.'));
    }
  } finally {
    clearTimeout(timeout);
  }
}

function textValue(value: unknown, fallback: string, maximum: number): string {
  // Fast2SMS separates body variables with `|`; remove any literal pipe in a
  // task value so the approved six-variable template always receives six.
  const text = String(value ?? '').trim().replace(/\s+/g, ' ').replaceAll('|', '¦');
  if (!text) return fallback;
  return text.length > maximum ? `${text.slice(0, Math.max(1, maximum - 1))}…` : text;
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function isActive(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return ['active', '1', 'true', 'enabled'].includes(String(value).trim().toLowerCase());
}

function fast2SmsNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  // User profiles may store Indian WhatsApp numbers as +91XXXXXXXXXX, while
  // Fast2SMS's `numbers` parameter expects the local mobile number.
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

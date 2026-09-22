import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { createLegacyRecord, listRawRecords, updateLegacyRecord } from './legacyRepository.js';
import type { LegacyRecord } from '../db/legacy.js';
import { HttpError } from '../utils/http.js';

const SETTINGS_KEY = 'whatsapp_business_gateway';
const CAMPAIGN_KEY = 'whatsapp_business_campaign';
const GRAPH_ROOT = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}`;
const campaignsInFlight = new Set<string>();

type Cipher = { ciphertext: string; iv: string; tag: string };
interface SavedPhone {
  key: string;
  number_ciphertext: string;
  number_iv: string;
  number_tag: string;
  display_phone_number: string | null;
  verified_name: string | null;
  status: string | null;
  quality_rating: string | null;
  code_verification_status: string | null;
  platform_type: string | null;
}
interface MetaPhone {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
}
interface MetaTemplate {
  id?: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  components?: unknown[];
  quality_score?: unknown;
  rejected_reason?: string;
  parameter_format?: string;
}

export interface WhatsAppPhoneView {
  key: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  activationStatus: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
  platformType: string | null;
}
export interface WhatsAppAccountView {
  id: string;
  name: string;
  connected: boolean;
  phones: WhatsAppPhoneView[];
  createdAt: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
}
export interface WhatsAppTemplateView {
  id: string;
  name: string;
  status: string;
  category: string | null;
  language: string | null;
  components: unknown[];
  qualityScore: unknown;
  rejectedReason: string | null;
  parameterFormat: string | null;
  editable: boolean;
}
export interface WhatsAppCampaignView {
  id: string;
  name: string;
  accountName: string;
  phone: string | null;
  templateName: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

export async function listWhatsAppBusinessAccounts(): Promise<WhatsAppAccountView[]> {
  const records = await listRawRecords('app_settings', { 'raw.key': SETTINGS_KEY, 'raw.deleted_at': { $exists: false } }, 100);
  return records.map(toAccountView);
}

export async function createWhatsAppBusinessAccount(input: { name: string; accessToken: string; wabaId: string }, updatedBy: number): Promise<WhatsAppAccountView> {
  const phones = await fetchPhones(input.accessToken, input.wabaId);
  if (!phones.length) throw new HttpError(422, 'Meta returned no phone numbers for this WhatsApp Business account.');
  const token = encrypt(input.accessToken);
  const businessId = encrypt(input.wabaId);
  const now = nowIst();
  const accountId = crypto.randomUUID();
  const phoneRows = phones.map(savePhone);
  await createLegacyRecord('app_settings', {
    key: SETTINGS_KEY,
    account_id: accountId,
    business_name: input.name,
    access_token_ciphertext: token.ciphertext,
    access_token_iv: token.iv,
    access_token_tag: token.tag,
    waba_id_ciphertext: businessId.ciphertext,
    waba_id_iv: businessId.iv,
    waba_id_tag: businessId.tag,
    phone_numbers: phoneRows,
    connection_status: 'connected',
    credential_version: 2,
    created_by: updatedBy,
    created_at: now,
    updated_by: updatedBy,
    updated_at: now,
    last_verified_at: now
  });
  return toAccountView((await findAccount(accountId))!);
}

export async function updateWhatsAppBusinessAccount(accountId: string, input: { name?: string; accessToken?: string; wabaId?: string }, updatedBy: number): Promise<WhatsAppAccountView> {
  const record = await requireAccount(accountId);
  const raw = record.raw;
  const hasCredentials = Boolean(input.accessToken || input.wabaId);
  if (hasCredentials && (!input.accessToken || !input.wabaId)) throw new HttpError(400, 'Provide both the access token and WhatsApp Business Account ID when replacing credentials.');
  let fields: Record<string, unknown> = { ...raw, business_name: input.name ?? safeText(raw.business_name), updated_by: updatedBy, updated_at: nowIst() };
  if (hasCredentials && input.accessToken && input.wabaId) {
    const phones = await fetchPhones(input.accessToken, input.wabaId);
    if (!phones.length) throw new HttpError(422, 'Meta returned no phone numbers for this WhatsApp Business account.');
    const token = encrypt(input.accessToken);
    const businessId = encrypt(input.wabaId);
    const now = nowIst();
    fields = {
      ...fields,
      access_token_ciphertext: token.ciphertext, access_token_iv: token.iv, access_token_tag: token.tag,
      waba_id_ciphertext: businessId.ciphertext, waba_id_iv: businessId.iv, waba_id_tag: businessId.tag,
      phone_numbers: phones.map(savePhone), connection_status: 'connected', last_verified_at: now
    };
  }
  await updateLegacyRecord('app_settings', recordId(record), fields);
  return toAccountView((await findAccount(accountId))!);
}

export async function deleteWhatsAppBusinessAccount(accountId: string, updatedBy: number): Promise<{ id: string; deleted: true }> {
  const record = await requireAccount(accountId);
  await updateLegacyRecord('app_settings', recordId(record), {
    ...record.raw,
    access_token_ciphertext: null, access_token_iv: null, access_token_tag: null,
    waba_id_ciphertext: null, waba_id_iv: null, waba_id_tag: null, phone_numbers: [],
    connection_status: 'deleted', deleted_at: nowIst(), deleted_by: updatedBy, updated_at: nowIst(), updated_by: updatedBy
  });
  return { id: accountId, deleted: true };
}

export async function refreshWhatsAppBusinessAccount(accountId: string, updatedBy: number): Promise<WhatsAppAccountView> {
  const record = await requireAccount(accountId);
  const { token, wabaId } = decryptAccount(record);
  const phones = await fetchPhones(token, wabaId);
  const now = nowIst();
  await updateLegacyRecord('app_settings', recordId(record), {
    ...record.raw, phone_numbers: phones.map(savePhone), connection_status: 'connected', last_verified_at: now, updated_at: now, updated_by: updatedBy
  });
  return toAccountView((await findAccount(accountId))!);
}

export async function listWhatsAppTemplates(accountId: string): Promise<WhatsAppTemplateView[]> {
  const record = await requireAccount(accountId);
  const { token, wabaId } = decryptAccount(record);
  let url: string | null = `${GRAPH_ROOT}/${wabaId}/message_templates?fields=id,name,status,category,language,components,quality_score,rejected_reason,parameter_format&limit=100`;
  const results: WhatsAppTemplateView[] = [];
  for (let page = 0; url && page < 5 && results.length < 500; page += 1) {
    const body = await graphRequest(url, token, 'GET');
    const data = Array.isArray(body.data) ? body.data as MetaTemplate[] : [];
    results.push(...data.map(toTemplateView));
    const next = (body.paging as Record<string, unknown> | undefined)?.next;
    if (typeof next === 'string') {
      try {
        const nextUrl = new URL(next);
        url = nextUrl.origin === 'https://graph.facebook.com' && nextUrl.pathname.startsWith(`/${env.WHATSAPP_GRAPH_API_VERSION}/`) ? nextUrl.toString() : null;
      } catch { url = null; }
    } else url = null;
  }
  return results;
}

export async function createWhatsAppTemplate(accountId: string, input: { name: string; category: string; language: string; components: unknown[] }): Promise<WhatsAppTemplateView> {
  const record = await requireAccount(accountId);
  const { token, wabaId } = decryptAccount(record);
  const body = await graphRequest(`${GRAPH_ROOT}/${wabaId}/message_templates`, token, 'POST', input);
  const id = safeText(body.id);
  if (!id) throw new HttpError(502, 'Meta accepted the request but did not return a template ID. Refresh the template list to confirm its status.');
  const templates = await listWhatsAppTemplates(accountId);
  return templates.find((template) => template.id === id) ?? { id, name: input.name, status: 'PENDING', category: input.category, language: input.language, components: input.components, qualityScore: null, rejectedReason: null, parameterFormat: null, editable: false };
}

export async function updateWhatsAppTemplate(accountId: string, templateId: string, input: { components: unknown[] }): Promise<WhatsAppTemplateView> {
  const templates = await listWhatsAppTemplates(accountId);
  const existing = templates.find((template) => template.id === templateId);
  if (!existing) throw new HttpError(404, 'WhatsApp template not found for this business account.');
  if (!existing.editable) throw new HttpError(409, 'Meta allows template edits only while the template is approved or rejected.');
  const record = await requireAccount(accountId);
  const { token } = decryptAccount(record);
  await graphRequest(`${GRAPH_ROOT}/${templateId}`, token, 'POST', { components: input.components });
  const refreshed = await listWhatsAppTemplates(accountId);
  return refreshed.find((template) => template.id === templateId) ?? { ...existing, components: input.components };
}

export async function deleteWhatsAppTemplate(accountId: string, templateId: string): Promise<{ id: string; deleted: true }> {
  const record = await requireAccount(accountId);
  const { token, wabaId } = decryptAccount(record);
  const templates = await listWhatsAppTemplates(accountId);
  if (!templates.some((template) => template.id === templateId)) throw new HttpError(404, 'WhatsApp template not found for this business account.');
  const url = new URL(`${GRAPH_ROOT}/${wabaId}/message_templates`);
  url.searchParams.set('hsm_id', templateId);
  await graphRequest(url.toString(), token, 'DELETE');
  return { id: templateId, deleted: true };
}

export async function listWhatsAppCampaignAccounts(): Promise<WhatsAppAccountView[]> {
  return (await listWhatsAppBusinessAccounts()).map((account) => ({
    ...account,
    phones: account.phones.filter((phone) => ['CONNECTED', 'ACTIVE', 'REGISTERED'].includes(String(phone.activationStatus).toUpperCase()))
  })).filter((account) => account.connected && account.phones.length > 0);
}

export async function listWhatsAppCampaigns(userId: number): Promise<WhatsAppCampaignView[]> {
  const records = await listRawRecords('app_settings', { 'raw.key': CAMPAIGN_KEY, 'raw.created_by': userId }, 100);
  return records.map(toCampaignView);
}

export async function createWhatsAppCampaign(input: {
  name: string;
  accountId: string;
  phoneKey: string;
  templateId: string;
  recipients: Array<{ phone: string; variables: string[] }>;
  allRecipientsOptedIn: true;
}, createdBy: number): Promise<WhatsAppCampaignView> {
  if (!input.recipients.length || input.recipients.length > 1_000) throw new HttpError(400, 'Add between 1 and 1,000 opted-in recipients.');
  const record = await requireAccount(input.accountId);
  const account = toAccountView(record);
  if (!account.connected) throw new HttpError(409, 'This WhatsApp Business account is not connected.');
  const phone = account.phones.find((item) => item.key === input.phoneKey);
  if (!phone || !['CONNECTED', 'ACTIVE', 'REGISTERED'].includes(String(phone.activationStatus).toUpperCase())) throw new HttpError(409, 'Choose a phone number that Meta reports as active and connected.');
  const templates = await listWhatsAppTemplates(input.accountId);
  const template = templates.find((item) => item.id === input.templateId);
  if (!template || template.status.toUpperCase() !== 'APPROVED') throw new HttpError(409, 'Only a Meta-approved message template can be used for a campaign.');
  if (!isCampaignTemplateSupported(template)) throw new HttpError(422, 'This template uses media or variables outside the message body. Campaigns currently support text template body variables only.');
  const bodyComponent = template.components.find((component) => component && typeof component === 'object' && String((component as Record<string, unknown>).type).toUpperCase() === 'BODY') as Record<string, unknown> | undefined;
  const bodyText = typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
  const variableCount = (bodyText.match(/\{\{\d+\}\}/g) ?? []).length;
  const normalizedRecipients = input.recipients.map((recipient) => {
    const phoneNumber = recipient.phone.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new HttpError(400, 'Use international phone format, such as +919876543210.');
    if (recipient.variables.length !== variableCount || recipient.variables.some((value) => value.length > 1_024)) throw new HttpError(400, `This template requires exactly ${variableCount} body variable value(s) for each recipient.`);
    return { encrypted_payload: encrypt(JSON.stringify({ phone: phoneNumber, variables: recipient.variables })), state: 'pending', message_id: null, error: null, processed_at: null };
  });
  const uniquePhones = new Set<string>();
  for (const recipient of input.recipients) {
    const normalized = recipient.phone.replace(/[\s().-]/g, '');
    if (uniquePhones.has(normalized)) throw new HttpError(400, 'Each recipient phone number must appear only once in a campaign.');
    uniquePhones.add(normalized);
  }
  const now = nowIst();
  const campaignId = crypto.randomUUID();
  await createLegacyRecord('app_settings', {
    key: CAMPAIGN_KEY,
    campaign_id: campaignId,
    name: input.name,
    account_id: input.accountId,
    account_name: account.name,
    phone_key: input.phoneKey,
    phone_display: phone.displayPhoneNumber,
    template_id: template.id,
    template_name: template.name,
    template_language: template.language ?? 'en_US',
    variable_count: variableCount,
    recipients: normalizedRecipients,
    status: 'ready',
    all_recipients_opted_in: true,
    consent_attested_by: createdBy,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    last_error: null
  });
  const saved = await findCampaign(campaignId, createdBy);
  if (!saved) throw new HttpError(500, 'The WhatsApp campaign could not be saved.');
  return toCampaignView(saved);
}

export async function sendWhatsAppCampaignBatch(campaignId: string, userId: number): Promise<WhatsAppCampaignView> {
  if (campaignsInFlight.has(campaignId)) throw new HttpError(409, 'This campaign is already processing a batch.');
  campaignsInFlight.add(campaignId);
  try {
    const campaign = await findCampaign(campaignId, userId);
    if (!campaign) throw new HttpError(404, 'Campaign not found.');
    const current = campaign.raw;
    const recipients = Array.isArray(current.recipients) ? current.recipients as Array<Record<string, unknown>> : [];
    const account = await requireAccount(String(current.account_id));
    const { token } = decryptAccount(account);
    const phones = Array.isArray(account.raw.phone_numbers) ? account.raw.phone_numbers as SavedPhone[] : [];
    const phone = phones.find((item) => item.key === current.phone_key);
    if (!phone || !['CONNECTED', 'ACTIVE', 'REGISTERED'].includes(String(phone.status).toUpperCase())) throw new HttpError(409, 'The selected WhatsApp phone number is no longer active. Refresh the account status.');
    const phoneNumberId = decrypt(phone.number_ciphertext, phone.number_iv, phone.number_tag);
    const templates = await listWhatsAppTemplates(String(current.account_id));
    const template = templates.find((item) => item.id === current.template_id);
    if (!template || template.status.toUpperCase() !== 'APPROVED') throw new HttpError(409, 'Meta no longer reports this template as approved.');
    if (!isCampaignTemplateSupported(template)) throw new HttpError(422, 'This template is not supported for campaigns because it uses media or variables outside the message body.');
    if (current.status === 'completed') throw new HttpError(409, 'This campaign has no pending recipients.');
    const updatedAt = parseIstTimestamp(current.updated_at);
    const staleSending = current.status === 'sending' && (updatedAt === null || Date.now() - updatedAt > 10 * 60_000);
    if (current.status === 'sending' && !staleSending) throw new HttpError(409, 'A campaign batch is already processing. Refresh it in a few minutes.');
    if (staleSending) for (const recipient of recipients) {
      if (recipient.state === 'sending') {
        recipient.state = 'failed';
        recipient.error = 'Delivery status is unknown after an interrupted send. Check Meta before contacting this recipient again.';
        recipient.processed_at = nowIst();
        current.last_error = recipient.error;
      }
    }
    if (staleSending) {
      current.status = 'ready';
      current.updated_at = nowIst();
      await updateLegacyRecord('app_settings', recordId(campaign), current);
    }
    const pendingIndices = recipients.map((recipient, index) => recipient.state === 'pending' ? index : -1).filter((index) => index >= 0).slice(0, 10);
    if (!pendingIndices.length) throw new HttpError(409, 'This campaign has no pending recipients.');
    current.status = 'sending';
    current.updated_at = nowIst();
    await updateLegacyRecord('app_settings', recordId(campaign), current);
    for (const index of pendingIndices) {
      const recipient = recipients[index]!;
      recipient.state = 'sending';
      recipient.processed_at = nowIst();
      current.updated_at = nowIst();
      await updateLegacyRecord('app_settings', recordId(campaign), current);
      try {
        const payload = JSON.parse(decrypt((recipient.encrypted_payload as Cipher).ciphertext, (recipient.encrypted_payload as Cipher).iv, (recipient.encrypted_payload as Cipher).tag)) as { phone: string; variables: string[] };
        const messageComponents = Number(current.variable_count) > 0 ? [{ type: 'body', parameters: payload.variables.map((value) => ({ type: 'text', text: value })) }] : [];
        const result = await graphRequest(`${GRAPH_ROOT}/${phoneNumberId}/messages`, token, 'POST', {
          messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.phone.replace(/^\+/, ''), type: 'template',
          template: { name: current.template_name, language: { code: current.template_language }, ...(messageComponents.length ? { components: messageComponents } : {}) }
        });
        const messages = Array.isArray(result.messages) ? result.messages as Array<Record<string, unknown>> : [];
        recipient.state = 'sent';
        recipient.message_id = safeText(messages[0]?.id);
        recipient.error = null;
      } catch (error) {
        recipient.state = 'failed';
        recipient.error = error instanceof HttpError ? error.message.slice(0, 300) : 'Meta could not send this message.';
        current.last_error = recipient.error;
      }
      recipient.processed_at = nowIst();
      current.updated_at = nowIst();
      await updateLegacyRecord('app_settings', recordId(campaign), current);
    }
    current.status = recipients.some((recipient) => recipient.state === 'pending') ? 'ready' : 'completed';
    current.updated_at = nowIst();
    await updateLegacyRecord('app_settings', recordId(campaign), current);
    return toCampaignView((await findCampaign(campaignId, userId))!);
  } finally {
    campaignsInFlight.delete(campaignId);
  }
}

function toAccountView(record: LegacyRecord): WhatsAppAccountView {
  const raw = record.raw;
  const configured = hasEncrypted(raw.access_token_ciphertext, raw.access_token_iv, raw.access_token_tag)
    && hasEncrypted(raw.waba_id_ciphertext, raw.waba_id_iv, raw.waba_id_tag);
  const phones = Array.isArray(raw.phone_numbers) ? raw.phone_numbers as SavedPhone[] : [];
  return {
    id: String(raw.account_id), name: safeText(raw.business_name) ?? 'WhatsApp Business',
    connected: configured && raw.connection_status === 'connected',
    phones: phones.map((phone) => ({ key: phone.key, displayPhoneNumber: safeText(phone.display_phone_number), verifiedName: safeText(phone.verified_name), activationStatus: safeText(phone.status), qualityRating: safeText(phone.quality_rating), codeVerificationStatus: safeText(phone.code_verification_status), platformType: safeText(phone.platform_type) })),
    createdAt: safeText(raw.created_at), updatedAt: safeText(raw.updated_at), lastVerifiedAt: safeText(raw.last_verified_at)
  };
}

function toTemplateView(template: MetaTemplate): WhatsAppTemplateView {
  const status = safeText(template.status) ?? 'UNKNOWN';
  return {
    id: safeText(template.id) ?? '', name: safeText(template.name) ?? 'Unnamed template', status,
    category: safeText(template.category), language: safeText(template.language),
    components: Array.isArray(template.components) ? template.components : [],
    qualityScore: template.quality_score ?? null, rejectedReason: safeText(template.rejected_reason), parameterFormat: safeText(template.parameter_format),
    editable: ['APPROVED', 'REJECTED'].includes(status.toUpperCase())
  };
}

function isCampaignTemplateSupported(template: WhatsAppTemplateView): boolean {
  return template.components.every((component) => {
    if (!component || typeof component !== 'object') return false;
    const row = component as Record<string, unknown>;
    const type = String(row.type ?? '').toUpperCase();
    if (type === 'BODY') return true;
    if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(row.format ?? '').toUpperCase())) return false;
    return !/\{\{\d+\}\}/.test(JSON.stringify(row));
  });
}

function toCampaignView(record: LegacyRecord): WhatsAppCampaignView {
  const raw = record.raw;
  const recipients = Array.isArray(raw.recipients) ? raw.recipients as Array<Record<string, unknown>> : [];
  return {
    id: String(raw.campaign_id), name: safeText(raw.name) ?? 'WhatsApp campaign',
    accountName: safeText(raw.account_name) ?? 'WhatsApp Business', phone: safeText(raw.phone_display),
    templateName: safeText(raw.template_name) ?? 'Message template', status: safeText(raw.status) ?? 'unknown',
    totalRecipients: recipients.length,
    sentCount: recipients.filter((recipient) => recipient.state === 'sent').length,
    failedCount: recipients.filter((recipient) => recipient.state === 'failed').length,
    pendingCount: recipients.filter((recipient) => recipient.state === 'pending' || recipient.state === 'sending').length,
    createdAt: safeText(raw.created_at), updatedAt: safeText(raw.updated_at), lastError: safeText(raw.last_error)
  };
}

function savePhone(phone: MetaPhone): SavedPhone {
  const phoneId = safeText(phone.id);
  if (!phoneId || !/^\d{5,32}$/.test(phoneId)) throw new HttpError(502, 'Meta returned an invalid phone number ID.');
  const encrypted = encrypt(phoneId);
  return {
    key: crypto.randomUUID(), number_ciphertext: encrypted.ciphertext, number_iv: encrypted.iv, number_tag: encrypted.tag,
    display_phone_number: safeText(phone.display_phone_number), verified_name: safeText(phone.verified_name), status: safeText(phone.status),
    quality_rating: safeText(phone.quality_rating), code_verification_status: safeText(phone.code_verification_status), platform_type: safeText(phone.platform_type)
  };
}

async function fetchPhones(token: string, wabaId: string): Promise<MetaPhone[]> {
  const body = await graphRequest(`${GRAPH_ROOT}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating,code_verification_status,platform_type&limit=100`, token, 'GET');
  return Array.isArray(body.data) ? body.data as MetaPhone[] : [];
}

async function graphRequest(url: string, token: string, method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new HttpError(502, 'Meta could not be reached. Check the connection and try again.');
  }
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const metaError = result?.error as Record<string, unknown> | undefined;
    const message = typeof metaError?.message === 'string' ? metaError.message : '';
    const safeMessage = message.replace(/access token|token/gi, 'credential').slice(0, 240);
    throw new HttpError(422, safeMessage ? `Meta rejected the request: ${safeMessage}` : 'Meta rejected the WhatsApp Business request. Check permissions and the submitted template details.');
  }
  return result && typeof result === 'object' ? result : {};
}

async function findAccount(accountId: string): Promise<LegacyRecord | null> {
  const [record] = await listRawRecords('app_settings', { 'raw.key': SETTINGS_KEY, 'raw.account_id': accountId, 'raw.deleted_at': { $exists: false } }, 1);
  return record ?? null;
}
async function findCampaign(campaignId: string, createdBy: number): Promise<LegacyRecord | null> {
  const [record] = await listRawRecords('app_settings', { 'raw.key': CAMPAIGN_KEY, 'raw.campaign_id': campaignId, 'raw.created_by': createdBy }, 1);
  return record ?? null;
}
async function requireAccount(accountId: string): Promise<LegacyRecord> {
  const record = await findAccount(accountId);
  if (!record) throw new HttpError(404, 'WhatsApp Business account not found.');
  return record;
}
function decryptAccount(record: LegacyRecord): { token: string; wabaId: string } {
  try {
    return { token: decrypt(record.raw.access_token_ciphertext, record.raw.access_token_iv, record.raw.access_token_tag), wabaId: decrypt(record.raw.waba_id_ciphertext, record.raw.waba_id_iv, record.raw.waba_id_tag) };
  } catch {
    throw new HttpError(500, 'The saved WhatsApp account could not be opened. Edit it with fresh Meta credentials.');
  }
}
function recordId(record: LegacyRecord): number {
  if (typeof record.legacyId !== 'number' || !Number.isSafeInteger(record.legacyId)) throw new HttpError(500, 'The saved WhatsApp Business account record is invalid.');
  return record.legacyId;
}
function encrypt(value: string): Cipher {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(ciphertextValue: unknown, ivValue: unknown, tagValue: unknown): string {
  const ciphertext = safeText(ciphertextValue); const iv = safeText(ivValue); const tag = safeText(tagValue);
  if (!ciphertext || !iv || !tag) throw new Error('Missing encrypted WhatsApp credential fields.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
function encryptionKey(): Buffer {
  const secret = env.WHATSAPP_BUSINESS_ENCRYPTION_SECRET ?? env.SETTINGS_ENCRYPTION_SECRET ?? env.JWT_ACCESS_SECRET;
  return crypto.createHash('sha256').update(`kaki-crm/whatsapp-business/v2:${secret}`).digest();
}
function hasEncrypted(ciphertext: unknown, iv: unknown, tag: unknown): boolean { return Boolean(safeText(ciphertext) && safeText(iv) && safeText(tag)); }
function safeText(value: unknown): string | null { if (typeof value !== 'string') return null; const text = value.trim(); return text ? text : null; }
function parseIstTimestamp(value: unknown): number | null {
  const text = safeText(value);
  if (!text) return null;
  const timestamp = Date.parse(`${text.replace(' ', 'T')}+05:30`);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { toPublicRecord, type LegacyRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { createLegacyRecord, findLegacyRecord, listRawRecords, updateLegacyRecord } from '../services/legacyRepository.js';
import { legacyAssetUrl, persistIncomingFile } from '../services/storage.js';
import { asyncHandler, HttpError } from '../utils/http.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const createSchema = z.object({
  type: z.enum(['direct', 'group']).default('direct'),
  title: z.string().trim().max(255).optional().nullable(),
  participantIds: z.array(z.coerce.number().int().positive()).min(1).max(100)
});
const messageSchema = z.object({ body: z.string().trim().max(10_000).optional().nullable(), reply_to_id: z.coerce.number().int().positive().optional().nullable() });

export const messengerRouter = Router();
messengerRouter.use(requireAuth);

messengerRouter.get('/users', asyncHandler(async (_req, res) => {
  const users = await listRawRecords('users', { 'raw.status': 'active' }, 1_000);
  res.json({ data: users.map(toPublicRecord) });
}));

messengerRouter.get('/conversations', asyncHandler(async (req, res) => {
  const userId = req.auth!.legacyId;
  const memberships = await listRawRecords('messenger_participants', { 'raw.user_id': userId, 'raw.left_at': null }, 1_000);
  const conversationIds = memberships.map((membership) => Number(membership.raw.conversation_id)).filter(Number.isSafeInteger);
  const [conversations, messages, people] = await Promise.all([
    listRawRecords('messenger_conversations', { legacyId: { $in: conversationIds } }, 1_000),
    listRawRecords('messenger_messages', { 'raw.conversation_id': { $in: conversationIds } }, 5_000),
    listRawRecords('messenger_participants', { 'raw.conversation_id': { $in: conversationIds }, 'raw.left_at': null }, 5_000)
  ]);
  const lastByConversation = new Map<number, LegacyRecord>();
  for (const message of messages) {
    const id = Number(message.raw.conversation_id);
    const previous = lastByConversation.get(id);
    if (!previous || previous.createdAt < message.createdAt) lastByConversation.set(id, message);
  }
  const participantsByConversation = new Map<number, LegacyRecord[]>();
  for (const participant of people) {
    const id = Number(participant.raw.conversation_id);
    participantsByConversation.set(id, [...(participantsByConversation.get(id) ?? []), participant]);
  }
  res.json({
    data: conversations
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((conversation) => ({
        ...toPublicRecord(conversation),
        lastMessage: lastByConversation.get(conversation.legacyId!) ? toPublicRecord(lastByConversation.get(conversation.legacyId!)!) : null,
        participants: (participantsByConversation.get(conversation.legacyId!) ?? []).map(toPublicRecord)
      }))
  });
}));

messengerRouter.post('/conversations', asyncHandler(async (req, res) => {
  const input = createSchema.parse(req.body);
  const allParticipants = [...new Set([...input.participantIds, req.auth!.legacyId])];
  if (input.type === 'direct' && allParticipants.length !== 2) throw new HttpError(400, 'A direct conversation must have exactly two people.');
  if (input.type === 'direct') {
    const existing = await findDirectConversation(allParticipants);
    if (existing) {
      res.json({ data: toPublicRecord(existing) });
      return;
    }
  }
  const conversation = await createLegacyRecord('messenger_conversations', {
    type: input.type,
    title: input.type === 'group' ? input.title ?? 'Untitled group' : null,
    created_by: req.auth!.legacyId,
    last_message_id: null,
    is_active: 1,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  await Promise.all(allParticipants.map((userId) => createLegacyRecord('messenger_participants', {
    conversation_id: conversation.legacyId,
    user_id: userId,
    role: userId === req.auth!.legacyId ? 'owner' : 'member',
    last_read_message_id: null,
    is_muted: 0,
    joined_at: nowIst(),
    left_at: null
  })));
  res.status(201).json({ data: toPublicRecord(conversation) });
}));

messengerRouter.get('/conversations/:conversationId/messages', asyncHandler(async (req, res) => {
  const conversation = await requiredParticipant(req, conversationId(req.params.conversationId));
  const [messages, attachments] = await Promise.all([
    listRawRecords('messenger_messages', { 'raw.conversation_id': conversation.legacyId }, 1_000),
    listRawRecords('messenger_attachments', { 'raw.conversation_id': conversation.legacyId }, 5_000)
  ]);
  const attachmentsByMessage = new Map<number, LegacyRecord[]>();
  for (const attachment of attachments) {
    const messageId = Number(attachment.raw.message_id);
    attachmentsByMessage.set(messageId, [...(attachmentsByMessage.get(messageId) ?? []), attachment]);
  }
  res.json({ data: messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((message) => ({
    ...toPublicRecord(message),
    attachments: (attachmentsByMessage.get(message.legacyId!) ?? []).map((attachment) => ({ ...toPublicRecord(attachment), url: attachmentUrl(attachment) }))
  })) });
}));

messengerRouter.post('/conversations/:conversationId/messages', upload.array('files', 10), asyncHandler(async (req, res) => {
  const conversation = await requiredParticipant(req, conversationId(req.params.conversationId));
  const input = messageSchema.parse(req.body);
  const files = Array.isArray(req.files) ? req.files : [];
  if (!input.body && !files.length) throw new HttpError(400, 'A message needs text or at least one attachment.');
  const message = await createLegacyRecord('messenger_messages', {
    conversation_id: conversation.legacyId,
    sender_id: req.auth!.legacyId,
    message_type: files.length ? (input.body ? 'mixed' : 'attachment') : 'text',
    body: input.body ?? null,
    reply_to_id: input.reply_to_id ?? null,
    is_deleted: 0,
    created_at: nowIst(),
    updated_at: nowIst()
  });
  const attachments = await Promise.all(files.map(async (file) => {
    const stored = await persistIncomingFile(file, 'messenger');
    return createLegacyRecord('messenger_attachments', {
      message_id: message.legacyId,
      conversation_id: conversation.legacyId,
      user_id: req.auth!.legacyId,
      stored_name: stored.relativePath,
      original_name: file.originalname,
      mime: file.mimetype,
      size_bytes: file.size,
      created_at: nowIst()
    });
  }));
  await updateLegacyRecord('messenger_conversations', conversation.legacyId!, { last_message_id: message.legacyId, updated_at: nowIst() });
  const participants = await listRawRecords('messenger_participants', { 'raw.conversation_id': conversation.legacyId, 'raw.left_at': null }, 1_000);
  const payload = { ...toPublicRecord(message), attachments: attachments.map((attachment) => ({ ...toPublicRecord(attachment), url: attachmentUrl(attachment) })) };
  for (const participant of participants) {
    const recipient = Number(participant.raw.user_id);
    if (recipient !== req.auth!.legacyId) emitRealtime('messenger:message', { conversationId: conversation.legacyId, message: payload }, `user:${recipient}`);
  }
  res.status(201).json({ data: payload });
}));

messengerRouter.post('/conversations/:conversationId/read', asyncHandler(async (req, res) => {
  const conversation = await requiredParticipant(req, conversationId(req.params.conversationId));
  const latest = await listRawRecords('messenger_messages', { 'raw.conversation_id': conversation.legacyId }, 1_000);
  const lastId = latest.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.legacyId ?? null;
  const memberships = await listRawRecords('messenger_participants', { 'raw.conversation_id': conversation.legacyId, 'raw.user_id': req.auth!.legacyId }, 1);
  if (memberships[0]) await updateLegacyRecord('messenger_participants', memberships[0].legacyId!, { last_read_message_id: lastId });
  res.status(204).send();
}));

async function requiredParticipant(req: import('express').Request, id: number): Promise<LegacyRecord> {
  const conversation = await findLegacyRecord('messenger_conversations', id);
  if (!conversation) throw new HttpError(404, 'Conversation not found.');
  const membership = await listRawRecords('messenger_participants', { 'raw.conversation_id': id, 'raw.user_id': req.auth!.legacyId, 'raw.left_at': null }, 1);
  if (!membership.length) throw new HttpError(403, 'You are not a participant in this conversation.');
  return conversation;
}

async function findDirectConversation(participantIds: number[]): Promise<LegacyRecord | null> {
  const conversations = await listRawRecords('messenger_conversations', { 'raw.type': 'direct', 'raw.is_active': { $ne: 0 } }, 1_000);
  for (const conversation of conversations) {
    const members = await listRawRecords('messenger_participants', { 'raw.conversation_id': conversation.legacyId, 'raw.left_at': null }, 10);
    const ids = members.map((member) => Number(member.raw.user_id)).sort((a, b) => a - b);
    const target = [...participantIds].sort((a, b) => a - b);
    if (ids.length === target.length && ids.every((value, index) => value === target[index])) return conversation;
  }
  return null;
}

function attachmentUrl(attachment: LegacyRecord): string | null {
  const storedName = String(attachment.raw.stored_name ?? attachment.raw.storage_path ?? '');
  if (!storedName) return null;
  return legacyAssetUrl(storedName.startsWith('modern/') ? storedName : `legacy/uploads/messenger/${storedName}`);
}

function conversationId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, 'Invalid conversation ID.');
  return parsed;
}

function nowIst(): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return `${date} ${time}`;
}

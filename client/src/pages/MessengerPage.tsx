import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCirclePlus, Send, UsersRound } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, type PublicRecord } from '../lib/api.js';
import { dateTime, displayValue, initials } from '../lib/format.js';

interface Conversation extends PublicRecord { lastMessage: PublicRecord | null; participants: PublicRecord[]; }
interface Message extends PublicRecord { attachments: Array<PublicRecord & { url: string | null }>; }

export function MessengerPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [recipient, setRecipient] = useState('');
  const conversationsQuery = useQuery({ queryKey: ['messenger-conversations'], queryFn: () => api<{ data: Conversation[] }>('/messenger/conversations') });
  const usersQuery = useQuery({ queryKey: ['messenger-users'], queryFn: () => api<{ data: PublicRecord[] }>('/messenger/users') });
  useEffect(() => { if (selected === null && conversationsQuery.data?.data[0]?.legacyId) setSelected(conversationsQuery.data.data[0].legacyId); }, [selected, conversationsQuery.data]);
  const messagesQuery = useQuery({ queryKey: ['messenger-messages', selected], enabled: Boolean(selected), queryFn: () => api<{ data: Message[] }>(`/messenger/conversations/${selected}/messages`) });
  if (conversationsQuery.isPending || usersQuery.isPending) return <LoadingState label="Opening messenger…" />;
  if (conversationsQuery.isError) return <ErrorState message={conversationsQuery.error.message} onRetry={() => void conversationsQuery.refetch()} />;
  const createConversation = async () => { if (!recipient) return; const created = await api<{ data: PublicRecord }>('/messenger/conversations', { method: 'POST', body: JSON.stringify({ type: 'direct', participantIds: [Number(recipient)] }) }); setSelected(created.data.legacyId); setRecipient(''); await client.invalidateQueries({ queryKey: ['messenger-conversations'] }); };
  const send = async (event: FormEvent) => { event.preventDefault(); if (!selected || !message.trim()) return; await api(`/messenger/conversations/${selected}/messages`, { method: 'POST', body: JSON.stringify({ body: message }) }); setMessage(''); await client.invalidateQueries({ queryKey: ['messenger-messages', selected] }); await client.invalidateQueries({ queryKey: ['messenger-conversations'] }); };
  const conversations = conversationsQuery.data.data;
  return <><PageHeader eyebrow="COLLABORATION" title="Messenger" description="Private and group conversations preserved from the legacy workspace." /><section className="messenger-layout"><aside className="conversation-panel"><div className="new-conversation"><select value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">Start a direct conversation…</option>{usersQuery.data?.data.map((user) => <option key={user.id} value={user.legacyId ?? ''}>{displayValue(user.fields.name)}</option>)}</select><button className="icon-button" onClick={() => void createConversation()} aria-label="Create conversation"><MessageCirclePlus size={18} /></button></div><div className="conversation-list">{conversations.map((conversation) => <button key={conversation.id} className={`conversation-row ${selected === conversation.legacyId ? 'conversation-row--active' : ''}`} onClick={() => setSelected(conversation.legacyId)}><span className="avatar">{initials(conversation.fields.title ?? `C${conversation.legacyId}`)}</span><span><strong>{displayValue(conversation.fields.title ?? conversation.participants.map((person) => `User #${person.fields.user_id}`).join(', '))}</strong><small>{displayValue(conversation.lastMessage?.fields.body ?? 'No messages yet')}</small></span></button>)}{!conversations.length && <p className="muted-copy">No conversations yet.</p>}</div></aside><article className="message-panel"><div className="message-header"><UsersRound size={19} /><strong>{selected ? `Conversation #${selected}` : 'Select a conversation'}</strong></div>{messagesQuery.isPending && selected ? <LoadingState label="Loading messages…" /> : <div className="message-thread">{messagesQuery.data?.data.map((entry) => <div className="message-entry" key={entry.id}><span className="avatar avatar--small">{initials(`U${entry.fields.sender_id}`)}</span><div><strong>User #{displayValue(entry.fields.sender_id)}</strong><p>{displayValue(entry.fields.body)}</p>{entry.attachments.map((file) => file.url ? <a className="attachment-link" href={file.url} target="_blank" rel="noreferrer" key={file.id}>{displayValue(file.fields.original_name)}</a> : null)}<small>{dateTime(entry.fields.created_at ?? entry.createdAt)}</small></div></div>)}{selected && !messagesQuery.data?.data.length && <p className="muted-copy">Say hello to begin this conversation.</p>}</div>}<form className="chat-compose" onSubmit={(event) => void send(event)}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={selected ? 'Write a message…' : 'Select a conversation first'} disabled={!selected} /><button className="button" disabled={!selected}><Send size={17} /></button></form></article></section></>;
}

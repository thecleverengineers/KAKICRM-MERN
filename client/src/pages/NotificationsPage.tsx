import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CheckCheck } from 'lucide-react';
import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, LoadingState, EmptyState } from '../components/LoadingState.js';
import { api, type Paginated, type PublicRecord } from '../lib/api.js';
import { dateTime, displayValue } from '../lib/format.js';
import { useNavigate } from 'react-router-dom';

export function NotificationsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['notifications'], queryFn: () => api<Paginated<PublicRecord> & { unread: number }>('/notifications?limit=100') });
  if (query.isPending) return <LoadingState label="Loading notifications…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const markAll = async () => { await api('/notifications/mark-all-read', { method: 'POST' }); await client.invalidateQueries({ queryKey: ['notifications'] }); };
  const markRead = async (record: PublicRecord) => { if (Number(record.fields.is_read)) return; await api(`/notifications/${record.legacyId}/read`, { method: 'PATCH' }); await client.invalidateQueries({ queryKey: ['notifications'] }); };
  const openNotification = async (record: PublicRecord) => {
    try {
      await markRead(record);
    } finally {
      navigate(notificationDestination(record));
    }
  };
  return <><PageHeader eyebrow="COLLABORATION" title="Notifications" description={`${query.data.unread} unread notification${query.data.unread === 1 ? '' : 's'}.`} actions={<button className="button button--secondary" onClick={() => void markAll()}><CheckCheck size={17} /> Mark all read</button>} /><article className="content-card notification-card">{query.data.data.map((record) => <button className={`notification-row ${Number(record.fields.is_read) ? '' : 'notification-row--unread'}`} key={record.id} type="button" onClick={() => void openNotification(record)}><span className="activity-icon"><BellRing size={17} /></span><span><strong>{displayValue(record.fields.title)}</strong><p>{displayValue(record.fields.body)}</p><small>{dateTime(record.fields.created_at ?? record.createdAt)}</small></span></button>)}{!query.data.data.length && <EmptyState title="You are all caught up" detail="New alerts from tasks and workspace activity will appear here." />}</article></>;
}

function notificationDestination(record: Pick<PublicRecord, 'fields'>): string {
  const candidate = String(record.fields.url ?? '').trim();
  if (candidate.startsWith('/')) return candidate;
  const taskId = Number(record.fields.task_id ?? record.fields.entity_id);
  return Number.isSafeInteger(taskId) && taskId > 0 ? `/tasks/${taskId}` : '/notifications';
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, AtSign, ChevronLeft, ChevronRight, Clock3, Download, FileText, ImagePlus, LoaderCircle, MessageCircle, Paperclip, Pencil, Plus, Save, Send, Trash2, UserPlus, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, apiUrl, getAccessToken, type PublicRecord } from '../lib/api.js';
import { date, dateTime, displayValue } from '../lib/format.js';
import { useAuth } from '../store/auth.js';

interface TaskUpdateAttachment extends PublicRecord {
  kind: 'image' | 'document';
}

interface TaskUpdateRecord extends PublicRecord {
  mentionedUserIds?: number[];
  attachments?: TaskUpdateAttachment[];
}

interface TaskChatRecord extends PublicRecord {
  mentionedUserIds?: number[];
}

interface TaskFileAttachment extends PublicRecord {
  kind: 'image' | 'document';
  source: 'task_file' | 'daily_update';
  updateId?: number;
}

interface UpdatesPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface TaskDetail {
  data: PublicRecord;
  updates: TaskUpdateRecord[];
  updatesPagination: UpdatesPagination;
  chat: TaskChatRecord[];
  followers: PublicRecord[];
  timeLogs: PublicRecord[];
  files: TaskFileAttachment[];
  filesPagination: UpdatesPagination;
}

interface MentionableEmployee {
  id: number;
  name: string;
  department: string | null;
  designation: string | null;
}

interface MentionableEmployeesResponse {
  data: MentionableEmployee[];
}

type DailyUpdateStatus = 'pending' | 'in_progress' | 'completed';
type TaskStatus = 'pending' | 'in_progress' | 'review' | 'completed' | 'blocked';

interface DailyUpdateInput {
  note: string;
  status: DailyUpdateStatus;
  tagUserIds: number[];
  attachments: File[];
  removeAttachmentIds: number[];
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const [message, setMessage] = useState('');
  const [chatMentionedUserIds, setChatMentionedUserIds] = useState<number[]>([]);
  const [update, setUpdate] = useState('');
  const [updateStatus, setUpdateStatus] = useState<DailyUpdateStatus>('in_progress');
  const [updateMentionedUserIds, setUpdateMentionedUserIds] = useState<number[]>([]);
  const [updateAttachments, setUpdateAttachments] = useState<File[]>([]);
  const [updatesPage, setUpdatesPage] = useState(1);
  const [filesPage, setFilesPage] = useState(1);
  const [postingUpdate, setPostingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [editingUpdate, setEditingUpdate] = useState<TaskUpdateRecord | null>(null);
  const [deletingUpdate, setDeletingUpdate] = useState<TaskUpdateRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('pending');
  const [savingTaskStatus, setSavingTaskStatus] = useState(false);
  const [taskStatusError, setTaskStatusError] = useState<string | null>(null);
  const [taskStatusNotice, setTaskStatusNotice] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [taskEditError, setTaskEditError] = useState<string | null>(null);
  const [archivingTask, setArchivingTask] = useState(false);

  const query = useQuery({
    queryKey: ['task', taskId, updatesPage, filesPage],
    enabled: Boolean(taskId),
    queryFn: () => api<TaskDetail>(`/tasks/${taskId}?updatesPage=${updatesPage}&filesPage=${filesPage}`)
  });
  const mentionQuery = useQuery({
    queryKey: ['task-mentionable-users', taskId],
    enabled: Boolean(taskId),
    queryFn: () => api<MentionableEmployeesResponse>(`/tasks/${taskId}/mentionable-users`)
  });

  useEffect(() => {
    if (query.data?.data.fields.status !== undefined) setTaskStatus(normalizeTaskStatus(query.data.data.fields.status));
  }, [query.data?.data.fields.status]);

  if (query.isPending) return <LoadingState label="Loading task workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const task = query.data;
  const mentionableEmployees = mentionQuery.data?.data ?? [];
  const peopleById = new Map(mentionableEmployees.map((person) => [person.id, person]));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['task', taskId] });
  const canManageUpdates = hasPermission('task.manage');
  const isEmployee = user?.role?.trim().toLowerCase() === 'employee';
  const canManageTask = isEmployee || isAdminOrHrRole(user?.role) || hasPermission('task.manage') || hasPermission('projects.manage') || hasPermission('departments.manage') || hasPermission('teams.manage');
  const canArchiveTask = canManageTask && (!isEmployee || [task.data.fields.created_by, task.data.fields.created_by_id, task.data.fields.assignee_id, task.data.fields.assignee_ids, task.data.fields.owner_id].some((value) => containsUserId(value, user?.legacyId)));
  const canUpdateTaskStatus = canManageTask;

  const saveTaskStatus = async () => {
    if (!taskId || !canUpdateTaskStatus || savingTaskStatus) return;
    const currentStatus = normalizeTaskStatus(task.data.fields.status);
    if (currentStatus === taskStatus) return;
    setSavingTaskStatus(true);
    setTaskStatusError(null);
    setTaskStatusNotice(null);
    try {
      await api(`/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status: taskStatus }) });
      setTaskStatusNotice('Task status updated.');
      await refresh();
    } catch (problem) {
      setTaskStatusError(problem instanceof Error ? problem.message : 'Unable to update the task status.');
    } finally {
      setSavingTaskStatus(false);
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    await api(`/tasks/${taskId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: message.trim(), mentionedUserIds: chatMentionedUserIds })
    });
    setMessage('');
    setChatMentionedUserIds([]);
    await refresh();
  };

  const sendUpdate = async (event: FormEvent) => {
    event.preventDefault();
    if (!update.trim()) {
      setUpdateError('Write a daily update before posting it.');
      return;
    }
    setPostingUpdate(true);
    setUpdateError(null);
    try {
      await api(`/tasks/${taskId}/updates`, {
        method: 'POST',
        body: dailyUpdateRequestBody({
          note: update.trim(),
          status: updateStatus,
          tagUserIds: updateMentionedUserIds,
          attachments: updateAttachments,
          removeAttachmentIds: []
        }, task.data.fields.priority)
      });
      setUpdate('');
      setUpdateStatus('in_progress');
      setUpdateMentionedUserIds([]);
      setUpdateAttachments([]);
      setUpdatesPage(1);
      await refresh();
    } catch (problem) {
      setUpdateError(problem instanceof Error ? problem.message : 'Unable to post the daily update.');
    } finally {
      setPostingUpdate(false);
    }
  };

  const saveUpdate = async (input: DailyUpdateInput) => {
    if (!editingUpdate?.legacyId) return;
    await api(`/tasks/${taskId}/updates/${editingUpdate.legacyId}`, {
      method: 'PATCH',
      body: dailyUpdateRequestBody(input)
    });
    setEditingUpdate(null);
    await refresh();
  };

  const removeUpdate = async () => {
    if (!deletingUpdate?.legacyId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/tasks/${taskId}/updates/${deletingUpdate.legacyId}`, { method: 'DELETE' });
      setDeletingUpdate(null);
      if (task.updates.length === 1 && updatesPage > 1) setUpdatesPage(updatesPage - 1);
      await refresh();
    } catch (problem) {
      setDeleteError(problem instanceof Error ? problem.message : 'Unable to remove the daily update.');
    } finally {
      setDeleting(false);
    }
  };

  const logTime = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(minutes);
    if (!value) return;
    await api(`/tasks/${taskId}/time-logs`, { method: 'POST', body: JSON.stringify({ minutes: value }) });
    setMinutes('');
    await refresh();
  };

  const follow = async () => {
    await api(`/tasks/${taskId}/followers`, { method: 'POST' });
    await refresh();
  };

  const saveTask = async (input: TaskEditInput) => {
    if (!taskId) return;
    setSavingTask(true);
    setTaskEditError(null);
    try {
      await api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) });
      setEditingTask(false);
      await refresh();
    } catch (problem) {
      setTaskEditError(problem instanceof Error ? problem.message : 'Unable to save this task.');
    } finally {
      setSavingTask(false);
    }
  };

  const archiveTask = async () => {
    if (!taskId || !canArchiveTask || archivingTask) return;
    if (!window.confirm('Archive this task? Its updates, chat, files and time logs will remain recoverable in Task Recycle.')) return;
    setArchivingTask(true);
    try {
      await api(`/tasks/${taskId}`, { method: 'DELETE' });
      navigate('/tasks');
    } catch (problem) {
      setTaskEditError(problem instanceof Error ? problem.message : 'Unable to archive this task.');
      setArchivingTask(false);
    }
  };

  return <>
    <PageHeader
      eyebrow="TASK WORKSPACE"
      title={displayValue(task.data.fields.title)}
      description={displayValue(task.data.fields.description)}
      actions={<><button className="button button--secondary" onClick={() => navigate('/tasks')}><ArrowLeft size={17} /> Back to tasks</button>{canManageTask && <button className="button button--secondary" onClick={() => { setTaskEditError(null); setEditingTask(true); }}><Pencil size={16} /> Edit task</button>}{canArchiveTask && <button className="button button--danger" onClick={() => void archiveTask()} disabled={archivingTask}><Trash2 size={16} /> {archivingTask ? 'Archiving…' : 'Archive'}</button>}<button className="button button--secondary" onClick={() => void follow()}><UserPlus size={17} /> Follow</button></>}
    />
    <section className="task-meta-grid"><div><span>Status</span>{canUpdateTaskStatus ? <div className="task-status-editor"><select value={taskStatus} onChange={(event) => { setTaskStatus(event.target.value as TaskStatus); setTaskStatusNotice(null); setTaskStatusError(null); }} disabled={savingTaskStatus} aria-label="Task status"><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="review">In review</option><option value="completed">Completed</option><option value="blocked">Blocked</option></select><button className="button button--compact" type="button" onClick={() => void saveTaskStatus()} disabled={savingTaskStatus || normalizeTaskStatus(task.data.fields.status) === taskStatus}>{savingTaskStatus ? 'Saving…' : 'Save'}</button></div> : <StatusPill value={task.data.fields.status} />}</div><div><span>Priority</span><StatusPill value={task.data.fields.priority} /></div><div><span>Due date</span><strong>{date(task.data.fields.due_date)}</strong></div><div><span>Assignees</span><strong>{displayValue(task.data.relationLabels?.assignee_ids ?? task.data.relationLabels?.assignee_id ?? task.data.fields.assignee_ids ?? task.data.fields.assignee_id)}</strong></div></section>
    {(taskStatusError || taskStatusNotice) && <p className={taskStatusError ? 'form-error task-status-feedback' : 'form-success task-status-feedback'} role="status">{taskStatusError ?? taskStatusNotice}</p>}
    <section className="task-layout">
      <div className="task-main-column">
        <article className="content-card">
          <div className="card-heading"><div><p className="eyebrow">PROGRESS</p><h2>Daily updates</h2></div><Plus size={19} /></div>
          <p className="daily-update-help"><AtSign size={14} /> Type <strong>@</strong> to notify an employee. You can also attach images and documents.</p>
          <DailyUpdateComposer
            value={update}
            onValueChange={setUpdate}
            status={updateStatus}
            onStatusChange={setUpdateStatus}
            mentionedUserIds={updateMentionedUserIds}
            onMentionedUserIdsChange={setUpdateMentionedUserIds}
            attachments={updateAttachments}
            onAttachmentsChange={setUpdateAttachments}
            people={mentionableEmployees}
            onSubmit={(event) => void sendUpdate(event)}
            submitting={postingUpdate}
            submitLabel={postingUpdate ? 'Posting…' : 'Post update'}
          />
          {updateError && <p className="form-error">{updateError}</p>}
          <div className="feed-list">
            {task.updates.map((entry) => {
              const canEdit = Number(entry.fields.user_id) === user?.legacyId || canManageUpdates;
              const mentionedPeople = (entry.mentionedUserIds ?? [])
                .map((personId) => peopleById.get(personId))
                .filter((person): person is MentionableEmployee => Boolean(person));
              return <article className="feed-item daily-update-entry" key={entry.id}>
                <div className="feed-dot" />
                <div>
                  <div className="daily-update-entry-heading">
                    <div className="daily-update-entry-title"><StatusPill value={dailyStatus(entry.fields)} /><strong>{displayValue(entry.relationLabels?.user_id ?? entry.fields.user_id)}</strong></div>
                    <div className="daily-update-entry-actions"><small>{dateTime(entry.fields.created_at ?? entry.createdAt)}{entry.fields.edited_at ? ' · Edited' : ''}</small>{canEdit && <><button className="icon-button icon-button--small" type="button" title="Edit daily update" aria-label="Edit daily update" onClick={() => setEditingUpdate(entry)}><Pencil size={15} /></button><button className="icon-button icon-button--small danger" type="button" title="Delete daily update" aria-label="Delete daily update" onClick={() => { setDeleteError(null); setDeletingUpdate(entry); }}><Trash2 size={15} /></button></>}</div>
                  </div>
                  <p>{displayValue(entry.fields.note)}</p>
                  {mentionedPeople.length > 0 && <div className="daily-update-mentions" aria-label="Employees notified about this update"><AtSign size={14} /><span>{mentionedPeople.map((person) => person.name).join(', ')}</span></div>}
                  {taskId && entry.legacyId && Boolean(entry.attachments?.length) && <DailyUpdateAttachmentList taskId={taskId} updateId={entry.legacyId} attachments={entry.attachments ?? []} />}
                </div>
              </article>;
            })}
            {!task.updates.length && <p className="muted-copy">No progress updates yet.</p>}
          </div>
          {task.updatesPagination.total > 0 && <DailyUpdatesPagination pagination={task.updatesPagination} onPageChange={setUpdatesPage} />}
        </article>
        <article className="content-card">
          <div className="card-heading"><div><p className="eyebrow">TASK CHAT</p><h2>Conversation</h2></div><MessageCircle size={19} /></div>
          <p className="daily-update-help"><AtSign size={14} /> Type <strong>@</strong> to assign or notify a staff member.</p>
          <div className="chat-thread">
            {task.chat.map((entry) => {
              const mentionedPeople = (entry.mentionedUserIds ?? [])
                .map((personId) => peopleById.get(personId))
                .filter((person): person is MentionableEmployee => Boolean(person));
              return <div className="chat-bubble" key={entry.id}>
                <strong>{displayValue(entry.relationLabels?.user_id ?? entry.fields.user_id)}</strong>
                <p>{displayValue(entry.fields.message)}</p>
                {mentionedPeople.length > 0 && <div className="task-chat-mentions" aria-label="Employees notified about this message"><AtSign size={13} /><span>{mentionedPeople.map((person) => person.name).join(', ')}</span></div>}
                <small>{dateTime(entry.fields.created_at ?? entry.createdAt)}</small>
              </div>;
            })}
            {!task.chat.length && <p className="muted-copy">Start the task conversation here.</p>}
          </div>
          <TaskChatComposer
            value={message}
            onValueChange={setMessage}
            mentionedUserIds={chatMentionedUserIds}
            onMentionedUserIdsChange={setChatMentionedUserIds}
            people={mentionableEmployees}
            onSubmit={(event) => void sendMessage(event)}
          />
        </article>
      </div>
      <aside className="task-side-column">
        <article className="content-card"><div className="card-heading"><div><p className="eyebrow">TIME</p><h2>Time logs</h2></div><Clock3 size={19} /></div><form className="compact-form" onSubmit={(event) => void logTime(event)}><input value={minutes} onChange={(event) => setMinutes(event.target.value)} type="number" min="1" placeholder="Minutes" /><button className="button" type="submit">Log</button></form><ul className="simple-list">{task.timeLogs.map((entry) => <li key={entry.id}><strong>{displayValue(entry.fields.minutes)} min</strong><span>{date(entry.fields.log_date)}</span></li>)}{!task.timeLogs.length && <li className="muted-copy">No time logged.</li>}</ul></article>
        <article className="content-card"><div className="card-heading"><div><p className="eyebrow">FOLLOWERS</p><h2>Watching</h2></div></div><ul className="simple-list">{task.followers.map((entry) => <li key={entry.id}><strong>{displayValue(entry.relationLabels?.user_id ?? entry.fields.user_id)}</strong></li>)}{!task.followers.length && <li className="muted-copy">No followers yet.</li>}</ul></article>
        <article className="content-card"><div className="card-heading"><div><p className="eyebrow">FILES</p><h2>Attachments</h2></div></div>{taskId && task.files.length > 0 && <TaskFilesAttachmentList taskId={taskId} attachments={task.files} />}{!task.files.length && <p className="muted-copy">No files attached.</p>}{task.filesPagination.total > 0 && <TaskFilesPagination pagination={task.filesPagination} onPageChange={setFilesPage} />}</article>
      </aside>
    </section>
    {editingUpdate && taskId && <EditDailyUpdateDialog key={editingUpdate.id} taskId={taskId} entry={editingUpdate} people={mentionableEmployees} onClose={() => setEditingUpdate(null)} onSave={saveUpdate} />}
    {deletingUpdate && <DeleteDailyUpdateDialog entry={deletingUpdate} deleting={deleting} error={deleteError} onClose={() => { if (!deleting) setDeletingUpdate(null); }} onConfirm={() => void removeUpdate()} />}
    {editingTask && <TaskEditDialog task={task.data} people={mentionableEmployees} saving={savingTask} error={taskEditError} onClose={() => { if (!savingTask) setEditingTask(false); }} onSave={(input) => void saveTask(input)} />}
  </>;
}

interface TaskEditInput {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  due_date: string | null;
  assignee_ids: number[];
}

function TaskEditDialog({ task, people, saving, error, onClose, onSave }: { task: PublicRecord; people: MentionableEmployee[]; saving: boolean; error: string | null; onClose: () => void; onSave: (input: TaskEditInput) => void }) {
  const [title, setTitle] = useState(String(task.fields.title ?? ''));
  const [description, setDescription] = useState(String(task.fields.description ?? ''));
  const [status, setStatus] = useState<TaskStatus>(normalizeTaskStatus(task.fields.status));
  const [priority, setPriority] = useState(String(task.fields.priority ?? 'normal'));
  const [dueDate, setDueDate] = useState(String(task.fields.due_date ?? '').slice(0, 10));
  const [assigneeIds, setAssigneeIds] = useState<number[]>(initialTaskAssigneeIds(task));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim() || null, status, priority, due_date: dueDate || null, assignee_ids: assigneeIds });
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label="Edit task" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">TASK WORKSPACE</p><h2>Edit task</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div>
    <form onSubmit={submit}><div className="form-grid"><label className="field field--wide"><span>Task title *</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} required autoFocus /></label><label className="field field--wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} maxLength={20000} /></label><label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{['pending', 'in_progress', 'review', 'completed', 'blocked'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label><label className="field"><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{['low', 'normal', 'high', 'urgent'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label className="field field--wide"><span>Assign to employees</span><select multiple size={Math.min(8, Math.max(4, people.length))} value={assigneeIds.map(String)} onChange={(event) => setAssigneeIds(Array.from(event.currentTarget.selectedOptions).map((option) => Number(option.value)))}>{people.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select><small>Hold Ctrl/Cmd to select multiple employees.</small></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" type="submit" disabled={saving}><Save size={16} /> {saving ? 'Saving…' : 'Save task'}</button></div></form>
  </section></div>;
}

function DailyUpdateComposer({
  value,
  onValueChange,
  status,
  onStatusChange,
  mentionedUserIds,
  onMentionedUserIdsChange,
  attachments,
  onAttachmentsChange,
  existingAttachments = [],
  onRemoveExistingAttachment,
  taskId,
  updateId,
  people,
  onSubmit,
  submitting,
  submitLabel
}: {
  value: string;
  onValueChange: (value: string) => void;
  status: DailyUpdateStatus;
  onStatusChange: (status: DailyUpdateStatus) => void;
  mentionedUserIds: number[];
  onMentionedUserIdsChange: (userIds: number[]) => void;
  attachments: File[];
  onAttachmentsChange: (files: File[]) => void;
  existingAttachments?: TaskUpdateAttachment[];
  onRemoveExistingAttachment?: (attachmentId: number) => void;
  taskId?: string;
  updateId?: number;
  people: MentionableEmployee[];
  onSubmit: (event: FormEvent) => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const selectedPeople = mentionedUserIds.map((personId) => people.find((person) => person.id === personId)).filter((person): person is MentionableEmployee => Boolean(person));
  const suggestions = mention
    ? people.filter((person) => person.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8)
    : [];

  const updateText = (nextValue: string, cursor: number) => {
    onValueChange(nextValue);
    const beforeCursor = nextValue.slice(0, cursor);
    const trigger = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (trigger) {
      const query = trigger[1] ?? '';
      setMention({ query, start: cursor - query.length - 1, end: cursor });
    } else {
      setMention(null);
    }

    const retainedUserIds = mentionedUserIds.filter((personId) => {
      const person = people.find((candidate) => candidate.id === personId);
      return !person || nextValue.includes(`@${person.name}`);
    });
    if (retainedUserIds.length !== mentionedUserIds.length) onMentionedUserIdsChange(retainedUserIds);
  };

  const chooseMention = (person: MentionableEmployee) => {
    if (!mention) return;
    const replacement = `@${person.name} `;
    const nextValue = `${value.slice(0, mention.start)}${replacement}${value.slice(mention.end)}`;
    onValueChange(nextValue);
    if (!mentionedUserIds.includes(person.id)) onMentionedUserIdsChange([...mentionedUserIds, person.id]);
    const nextCursor = mention.start + replacement.length;
    setMention(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const addAttachments = (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    const remaining = Math.max(0, 10 - attachments.length);
    if (picked.length > remaining) setAttachmentNotice(`Only ${remaining || 'no'} more attachment${remaining === 1 ? '' : 's'} can be added to this update.`);
    else setAttachmentNotice(null);
    onAttachmentsChange([...attachments, ...picked.slice(0, remaining)]);
    if (attachmentInput.current) attachmentInput.current.value = '';
  };

  return <form className="inline-form daily-update-form" onSubmit={onSubmit}>
    <div className="daily-update-textarea-wrap">
      <textarea
        ref={textarea}
        value={value}
        onChange={(event) => updateText(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onBlur={() => window.setTimeout(() => setMention(null), 120)}
        placeholder="Share progress, blockers or next steps… Use @ to notify an employee."
        maxLength={10000}
      />
      {mention && <div className="daily-mention-menu" role="listbox" aria-label="Mention an employee">
        <div className="daily-mention-menu-label"><AtSign size={14} /> {mention.query ? 'Matching employees' : 'All employees'}</div>
        {suggestions.map((person) => <button key={person.id} className="daily-mention-option" type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(person)}><span><strong>{person.name}</strong>{(person.designation || person.department) && <small>{[person.designation, person.department].filter(Boolean).join(' · ')}</small>}</span><AtSign size={14} /></button>)}
        {!suggestions.length && <p className="daily-mention-empty">No active employees match this name.</p>}
      </div>}
      {selectedPeople.length > 0 && <div className="daily-mention-selected"><AtSign size={13} /><span>Will notify: {selectedPeople.map((person) => person.name).join(', ')}</span></div>}
      <div className="daily-update-upload-row"><input ref={attachmentInput} className="sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" onChange={(event) => addAttachments(event.target.files)} /><button className="button button--secondary daily-update-upload-button" type="button" onClick={() => attachmentInput.current?.click()} disabled={submitting || attachments.length >= 10}><Paperclip size={15} /> Add image / document</button><small>Up to 10 files · 25 MB each</small></div>
      {attachmentNotice && <p className="daily-update-attachment-notice">{attachmentNotice}</p>}
      {attachments.length > 0 && <div className="daily-update-new-files">{attachments.map((file, index) => <button className="daily-update-file-chip" type="button" key={`${file.name}-${file.lastModified}-${index}`} onClick={() => onAttachmentsChange(attachments.filter((_, fileIndex) => fileIndex !== index))}>{isImageFile(file) ? <ImagePlus size={14} /> : <FileText size={14} />}<span>{file.name}</span><X size={13} /></button>)}</div>}
      {existingAttachments.length > 0 && taskId && updateId && <div className="daily-update-existing-files"><small>Current attachments</small><DailyUpdateAttachmentList taskId={taskId} updateId={updateId} attachments={existingAttachments} onRemoveAttachment={onRemoveExistingAttachment} /></div>}
    </div>
    <label className="daily-update-status-field"><span>Update status</span><select value={status} onChange={(event) => onStatusChange(event.target.value as DailyUpdateStatus)} disabled={submitting}><option value="pending">Pending</option><option value="in_progress">In Progress</option><option value="completed">Completed</option></select></label>
    <button className="button" type="submit" disabled={submitting}>{submitLabel}</button>
  </form>;
}

function TaskChatComposer({
  value,
  onValueChange,
  mentionedUserIds,
  onMentionedUserIdsChange,
  people,
  onSubmit
}: {
  value: string;
  onValueChange: (value: string) => void;
  mentionedUserIds: number[];
  onMentionedUserIdsChange: (userIds: number[]) => void;
  people: MentionableEmployee[];
  onSubmit: (event: FormEvent) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const selectedPeople = mentionedUserIds
    .map((personId) => people.find((person) => person.id === personId))
    .filter((person): person is MentionableEmployee => Boolean(person));
  const suggestions = mention
    ? people.filter((person) => person.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 8)
    : [];

  const updateText = (nextValue: string, cursor: number) => {
    onValueChange(nextValue);
    const beforeCursor = nextValue.slice(0, cursor);
    const trigger = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (trigger) {
      const query = trigger[1] ?? '';
      setMention({ query, start: cursor - query.length - 1, end: cursor });
    } else {
      setMention(null);
    }

    const retainedUserIds = mentionedUserIds.filter((personId) => {
      const person = people.find((candidate) => candidate.id === personId);
      return !person || nextValue.includes(`@${person.name}`);
    });
    if (retainedUserIds.length !== mentionedUserIds.length) onMentionedUserIdsChange(retainedUserIds);
  };

  const chooseMention = (person: MentionableEmployee) => {
    if (!mention) return;
    const replacement = `@${person.name} `;
    const nextValue = `${value.slice(0, mention.start)}${replacement}${value.slice(mention.end)}`;
    onValueChange(nextValue);
    if (!mentionedUserIds.includes(person.id)) onMentionedUserIdsChange([...mentionedUserIds, person.id]);
    const nextCursor = mention.start + replacement.length;
    setMention(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return <form className="chat-compose task-chat-compose" onSubmit={onSubmit}>
    <div className="task-chat-composer-field">
      <input
        ref={input}
        value={value}
        onChange={(event) => updateText(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onBlur={() => window.setTimeout(() => setMention(null), 120)}
        placeholder="Write a message… Use @ to notify staff."
        maxLength={10000}
      />
      {mention && <div className="daily-mention-menu task-chat-mention-menu" role="listbox" aria-label="Mention an employee">
        <div className="daily-mention-menu-label"><AtSign size={14} /> {mention.query ? 'Matching employees' : 'All employees'}</div>
        {suggestions.map((person) => <button key={person.id} className="daily-mention-option" type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(person)}><span><strong>{person.name}</strong>{(person.designation || person.department) && <small>{[person.designation, person.department].filter(Boolean).join(' · ')}</small>}</span><AtSign size={14} /></button>)}
        {!suggestions.length && <p className="daily-mention-empty">No active employees match this name.</p>}
      </div>}
      {selectedPeople.length > 0 && <div className="task-chat-selected"><AtSign size={13} /><span>Will notify: {selectedPeople.map((person) => person.name).join(', ')}</span></div>}
    </div>
    <button className="button" type="submit" aria-label="Send message" disabled={!value.trim()}><Send size={17} /></button>
  </form>;
}

function DailyUpdateAttachmentList({ taskId, updateId, attachments, onRemoveAttachment }: { taskId: string; updateId: number; attachments: TaskUpdateAttachment[]; onRemoveAttachment?: (attachmentId: number) => void }) {
  return <div className="daily-update-attachments">
    {attachments.map((attachment) => {
      if (!attachment.legacyId) return null;
      const endpoint = taskUpdateAttachmentEndpoint(taskId, updateId, attachment.legacyId);
      const name = attachmentName(attachment);
      const image = attachment.kind === 'image';
      return <div className={`daily-update-attachment daily-update-attachment--${attachment.kind}`} key={attachment.id}>
        {image ? <AuthenticatedUpdateImage endpoint={endpoint} alt={name} /> : <AuthenticatedUpdateDocument endpoint={endpoint} name={name} />}
        <div className="daily-update-attachment-meta"><strong title={name}>{name}</strong><small>{image ? 'Image attachment' : 'Document attachment'}{attachment.fields.size_bytes ? ` · ${fileSize(attachment.fields.size_bytes)}` : ''}</small></div>
        {onRemoveAttachment && <button className="icon-button icon-button--small danger" type="button" title="Remove attachment" aria-label={`Remove ${name}`} onClick={() => onRemoveAttachment(attachment.legacyId!)}><X size={14} /></button>}
      </div>;
    })}
  </div>;
}

function TaskFilesAttachmentList({ taskId, attachments }: { taskId: string; attachments: TaskFileAttachment[] }) {
  return <div className="task-files-attachments">
    {attachments.map((attachment) => {
      if (!attachment.legacyId) return null;
      const endpoint = taskFileAttachmentEndpoint(taskId, attachment);
      if (!endpoint) return null;
      const name = attachmentName(attachment);
      const image = attachment.kind === 'image';
      const sourceLabel = attachment.source === 'daily_update' ? 'Daily update attachment' : 'Task attachment';
      return <div className={`daily-update-attachment task-file-attachment daily-update-attachment--${attachment.kind}`} key={`${attachment.source}-${attachment.id}`}>
        {image ? <AuthenticatedUpdateImage endpoint={endpoint} alt={name} /> : <AuthenticatedUpdateDocument endpoint={endpoint} name={name} />}
        <div className="daily-update-attachment-meta"><strong title={name}>{name}</strong><small>{sourceLabel}{attachment.fields.size_bytes ? ` · ${fileSize(attachment.fields.size_bytes)}` : ''}</small></div>
      </div>;
    })}
  </div>;
}

function AuthenticatedUpdateImage({ endpoint, alt }: { endpoint: string; alt: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    setFailed(false);
    void (async () => {
      try {
        const blob = await fetchAttachmentBlob(endpoint);
        objectUrl = URL.createObjectURL(blob);
        if (active) setSource(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint]);

  if (source) return <img className="daily-update-attachment-image" src={source} alt={alt} />;
  return <div className="daily-update-image-placeholder">{failed ? <FileText size={20} /> : <LoaderCircle size={20} className="spin" />}<span>{failed ? 'Preview unavailable' : 'Loading image'}</span></div>;
}

function AuthenticatedUpdateDocument({ endpoint, name }: { endpoint: string; name: string }) {
  const previewKind = documentPreviewKind(name);
  const [pdfSource, setPdfSource] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (previewKind !== 'pdf') {
      setPdfSource(null);
      setPreviewFailed(false);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    setPdfSource(null);
    setPreviewFailed(false);
    void (async () => {
      try {
        const blob = await fetchAttachmentBlob(endpoint);
        objectUrl = URL.createObjectURL(blob);
        if (active) setPdfSource(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      } catch {
        if (active) setPreviewFailed(true);
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint, previewKind]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await fetchAttachmentBlob(endpoint);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } finally {
      setDownloading(false);
    }
  };

  return <div className="daily-update-document-preview" title={`${documentPreviewLabel(previewKind)} preview: ${name}`}>
    {previewKind === 'pdf' && pdfSource
      ? <iframe className="daily-update-pdf-thumbnail-frame" src={`${pdfSource}#page=1&zoom=page-width&toolbar=0&navpanes=0&scrollbar=0`} title={`Preview of ${name}`} tabIndex={-1} />
      : <DocumentTypeThumbnail kind={previewKind} loading={previewKind === 'pdf' && !previewFailed} />}
    <button className="daily-update-document-download" type="button" title={`Download ${name}`} aria-label={`Download ${name}`} onClick={() => void download()} disabled={downloading}>{downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}</button>
  </div>;
}

type DocumentPreviewKind = 'pdf' | 'word' | 'sheet' | 'slides' | 'text' | 'file';

function DocumentTypeThumbnail({ kind, loading }: { kind: DocumentPreviewKind; loading?: boolean }) {
  if (loading) return <div className="daily-update-document-thumbnail daily-update-document-thumbnail--loading"><LoaderCircle size={18} className="spin" /><span>PDF</span></div>;
  return <div className={`daily-update-document-thumbnail daily-update-document-thumbnail--${kind}`}><FileText size={18} /><span>{documentPreviewLabel(kind)}</span></div>;
}

function DailyUpdatesPagination({ pagination, onPageChange }: { pagination: UpdatesPagination; onPageChange: (page: number) => void }) {
  return <nav className="daily-updates-pagination" aria-label="Daily update pages"><span><strong>{pagination.total}</strong> daily update{pagination.total === 1 ? '' : 's'} · {pagination.limit} per page</span><div><button className="icon-button icon-button--small" type="button" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} aria-label="Previous daily updates"><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.pages}</span><button className="icon-button icon-button--small" type="button" disabled={pagination.page >= pagination.pages} onClick={() => onPageChange(pagination.page + 1)} aria-label="Next daily updates"><ChevronRight size={17} /></button></div></nav>;
}

function TaskFilesPagination({ pagination, onPageChange }: { pagination: UpdatesPagination; onPageChange: (page: number) => void }) {
  return <nav className="task-files-pagination" aria-label="Task file pages"><span><strong>{pagination.total}</strong> attachment{pagination.total === 1 ? '' : 's'} · {pagination.limit} per page</span><div><button className="icon-button icon-button--small" type="button" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} aria-label="Previous attachments"><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.pages}</span><button className="icon-button icon-button--small" type="button" disabled={pagination.page >= pagination.pages} onClick={() => onPageChange(pagination.page + 1)} aria-label="Next attachments"><ChevronRight size={17} /></button></div></nav>;
}

function EditDailyUpdateDialog({ taskId, entry, people, onClose, onSave }: { taskId: string; entry: TaskUpdateRecord; people: MentionableEmployee[]; onClose: () => void; onSave: (input: DailyUpdateInput) => Promise<void> }) {
  const [note, setNote] = useState(String(entry.fields.note ?? ''));
  const [status, setStatus] = useState<DailyUpdateStatus>(dailyStatus(entry.fields));
  const [mentionedUserIds, setMentionedUserIds] = useState<number[]>(entry.mentionedUserIds ?? []);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [removeAttachmentIds, setRemoveAttachmentIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleAttachments = (entry.attachments ?? []).filter((attachment) => !removeAttachmentIds.includes(attachment.legacyId ?? -1));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) {
      setError('Write a daily update before saving it.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ note: note.trim(), status, tagUserIds: mentionedUserIds, attachments, removeAttachmentIds });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to save the daily update.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose(); }}><section className="modal daily-update-edit-modal" role="dialog" aria-modal="true" aria-label="Edit daily update" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">DAILY UPDATE</p><h2>Edit update</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div>
    <p className="daily-update-modal-copy">Change the progress status, text, tagged employees, or attached images and documents.</p>
    <DailyUpdateComposer value={note} onValueChange={setNote} status={status} onStatusChange={setStatus} mentionedUserIds={mentionedUserIds} onMentionedUserIdsChange={setMentionedUserIds} attachments={attachments} onAttachmentsChange={setAttachments} existingAttachments={visibleAttachments} onRemoveExistingAttachment={(attachmentId) => setRemoveAttachmentIds((current) => current.includes(attachmentId) ? current : [...current, attachmentId])} taskId={taskId} updateId={entry.legacyId ?? undefined} people={people} onSubmit={(event) => void submit(event)} submitting={saving} submitLabel={saving ? 'Saving…' : 'Save changes'} />
    {error && <p className="form-error">{error}</p>}
  </section></div>;
}

function DeleteDailyUpdateDialog({ entry, deleting, error, onClose, onConfirm }: { entry: TaskUpdateRecord; deleting: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal daily-update-delete-modal" role="dialog" aria-modal="true" aria-label="Delete daily update" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">REMOVE DAILY UPDATE</p><h2>Delete this update?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={deleting} aria-label="Close"><X size={18} /></button></div>
    <p className="daily-update-delete-copy">This update and its attachments will be removed from the task activity feed: <strong>{displayValue(entry.fields.note)}</strong></p>
    <p className="daily-update-delete-note">The task, its assignee, files, messages, and time logs are unchanged.</p>
    {error && <p className="form-error">{error}</p>}
    <div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={16} /> {deleting ? 'Deleting…' : 'Delete update'}</button></div>
  </section></div>;
}

function dailyUpdateRequestBody(input: DailyUpdateInput, updatePriority?: unknown): FormData {
  const body = new FormData();
  body.set('note', input.note);
  body.set('update_status', input.status);
  body.set('tagUserIds', JSON.stringify(input.tagUserIds));
  if (updatePriority !== undefined) body.set('update_priority', String(updatePriority));
  if (input.removeAttachmentIds.length) body.set('removeAttachmentIds', JSON.stringify(input.removeAttachmentIds));
  for (const file of input.attachments) body.append('files', file);
  return body;
}

async function fetchAttachmentBlob(endpoint: string): Promise<Blob> {
  const headers = new Headers();
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(apiUrl(endpoint), { headers });
  if (!response.ok) throw new Error('The attachment could not be loaded.');
  return response.blob();
}

function taskUpdateAttachmentEndpoint(taskId: string, updateId: number, attachmentId: number): string {
  return `/tasks/${encodeURIComponent(taskId)}/updates/${updateId}/attachments/${attachmentId}`;
}

function taskFileAttachmentEndpoint(taskId: string, attachment: TaskFileAttachment): string | null {
  if (!attachment.legacyId) return null;
  if (attachment.source === 'daily_update') {
    const updateId = attachment.updateId;
    if (!Number.isSafeInteger(updateId) || (updateId ?? 0) <= 0) return null;
    return taskUpdateAttachmentEndpoint(taskId, updateId as number, attachment.legacyId);
  }
  return `/tasks/${encodeURIComponent(taskId)}/files/${attachment.legacyId}`;
}

function attachmentName(attachment: Pick<PublicRecord, 'fields'>): string {
  return String(attachment.fields.original_name ?? attachment.fields.stored_name ?? 'Attachment');
}

function documentPreviewKind(name: string): DocumentPreviewKind {
  const extension = name.trim().split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (extension === 'doc' || extension === 'docx') return 'word';
  if (extension === 'xls' || extension === 'xlsx') return 'sheet';
  if (extension === 'ppt' || extension === 'pptx') return 'slides';
  if (extension === 'txt' || extension === 'csv') return 'text';
  return 'file';
}

function documentPreviewLabel(kind: DocumentPreviewKind): string {
  if (kind === 'word') return 'DOC';
  if (kind === 'sheet') return 'XLS';
  if (kind === 'slides') return 'PPT';
  if (kind === 'text') return 'TXT';
  if (kind === 'file') return 'FILE';
  return 'PDF';
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(file.name);
}

function fileSize(value: unknown): string {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1) return '';
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function dailyStatus(fields: Record<string, unknown>): DailyUpdateStatus {
  const status = String(fields.daily_status ?? fields.update_status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  if (status === 'pending' || status === 'do_later') return 'pending';
  return 'in_progress';
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed';
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'working_on') return 'in_progress';
  if (normalized === 'review' || normalized === 'in_review') return 'review';
  if (normalized === 'blocked') return 'blocked';
  return 'pending';
}

function initialTaskAssigneeIds(task: PublicRecord): number[] {
  const values = Array.isArray(task.fields.assignee_ids) ? task.fields.assignee_ids : [task.fields.assignee_id];
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function containsUserId(value: unknown, userId: number | undefined): boolean {
  if (!userId) return false;
  if (Array.isArray(value)) return value.some((entry) => containsUserId(entry, userId));
  return Number(value) === userId;
}

function isAdminOrHrRole(value: string | undefined): boolean {
  const role = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['admin', 'administrator', 'hr', 'hr_manager', 'human_resources', 'human_resource'].includes(role);
}

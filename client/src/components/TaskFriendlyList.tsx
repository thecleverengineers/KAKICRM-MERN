import { ChevronLeft, ChevronRight, Clock3, FolderKanban, UserRound } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { type PublicRecord } from '../lib/api.js';
import { type TaskStatus } from '../lib/projects.js';

type TaskFriendlyListProps = {
  records: PublicRecord[];
  page: number;
  pages: number;
  total: number;
  onPageChange: (page: number) => void;
  onOpen: (record: PublicRecord) => void;
  selectable?: boolean;
  selectedLegacyIds?: number[];
  onSelectedLegacyIdsChange?: (ids: number[]) => void;
  onStatusChange: (taskId: number, status: TaskStatus) => Promise<void>;
  onPriorityChange: (taskId: number, priority: TaskPriority) => Promise<void>;
  statusUpdatingId?: number | null;
  priorityUpdatingId?: number | null;
  emptyTitle?: string;
};

type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

const statusOptions: Array<{ value: TaskStatus; label: string }> = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'blocked', label: 'Blocked' }
];

const priorityOptions: Array<{ value: TaskPriority; label: string }> = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' }
];

export function TaskFriendlyList({
  records,
  page,
  pages,
  total,
  onPageChange,
  onOpen,
  selectable = false,
  selectedLegacyIds = [],
  onSelectedLegacyIdsChange,
  onStatusChange,
  onPriorityChange,
  statusUpdatingId = null,
  priorityUpdatingId = null,
  emptyTitle = 'No tasks found'
}: TaskFriendlyListProps) {
  const visibleIds = records.map((record) => record.legacyId).filter((id): id is number => typeof id === 'number');
  const allVisibleSelected = Boolean(visibleIds.length) && visibleIds.every((id) => selectedLegacyIds.includes(id));

  const toggleTask = (taskId: number) => {
    if (!onSelectedLegacyIdsChange) return;
    onSelectedLegacyIdsChange(
      selectedLegacyIds.includes(taskId)
        ? selectedLegacyIds.filter((id) => id !== taskId)
        : [...selectedLegacyIds, taskId]
    );
  };

  const toggleVisible = () => {
    if (!onSelectedLegacyIdsChange) return;
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds);
      onSelectedLegacyIdsChange(selectedLegacyIds.filter((id) => !visibleSet.has(id)));
      return;
    }
    onSelectedLegacyIdsChange(Array.from(new Set([...selectedLegacyIds, ...visibleIds])));
  };

  if (!records.length) {
    return <section className="task-friendly-empty">
      <div className="task-friendly-empty__icon" aria-hidden="true">✓</div>
      <h2>{emptyTitle}</h2>
      <p>There is no work matching the current status, search or priority filter.</p>
    </section>;
  }

  return <section className="task-friendly-list" aria-label="Task list">
    <div className="task-friendly-list__bar">
      <div>
        <strong>{total} task{total === 1 ? '' : 's'}</strong>
        <span>Recommended workflow order</span>
      </div>
      {selectable && visibleIds.length > 0 && <button className="task-friendly-select-page" type="button" onClick={toggleVisible}>
        <span className={allVisibleSelected ? 'task-friendly-check is-checked' : 'task-friendly-check'} aria-hidden="true">{allVisibleSelected ? '✓' : ''}</span>
        {allVisibleSelected ? 'Clear page selection' : 'Select this page'}
      </button>}
    </div>

    <div className="task-friendly-list__rows">
      {records.map((record) => {
        const taskId = record.legacyId;
        const title = stringValue(record.fields.title) || 'Untitled task';
        const status = normalizeStatus(record.fields.status);
        const priority = normalizePriority(record.fields.priority);
        const assignee = record.relationLabels?.assignee_ids || record.relationLabels?.assignee_id || 'Unassigned';
        const project = record.relationLabels?.project_id || 'No project';
        const due = dueMeta(record.fields.due_date);
        const selected = typeof taskId === 'number' && selectedLegacyIds.includes(taskId);
        const statusUpdating = typeof taskId === 'number' && statusUpdatingId === taskId;
        const priorityUpdating = typeof taskId === 'number' && priorityUpdatingId === taskId;

        const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen(record);
        };

        return <article
          className={selected ? 'task-friendly-row is-selected' : 'task-friendly-row'}
          key={record.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(record)}
          onKeyDown={openFromKeyboard}
          aria-label={'Open task ' + title}
        >
          {selectable && typeof taskId === 'number' && <div className="task-friendly-row__select" onClick={(event) => event.stopPropagation()}>
            <button className={selected ? 'task-friendly-check is-checked' : 'task-friendly-check'} type="button" aria-label={selected ? 'Deselect ' + title : 'Select ' + title} onClick={() => toggleTask(taskId)}>
              {selected ? '✓' : ''}
            </button>
          </div>}

          <div className="task-friendly-row__main">
            <div className="task-friendly-row__title-line">
              <h3>{title}</h3>
              <div className="task-friendly-badges" onClick={(event) => event.stopPropagation()}>
                {typeof taskId === 'number' ? <>
                  <label className={'task-friendly-inline-select task-friendly-status task-friendly-status--' + status}>
                    <span className="sr-only">Change status for {title}</span>
                    <select
                      value={status}
                      disabled={statusUpdating}
                      onChange={(event) => void onStatusChange(taskId, event.target.value as TaskStatus)}
                      aria-label={'Change status for ' + title}
                    >
                      {statusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className={'task-friendly-inline-select task-friendly-priority task-friendly-priority--' + priority}>
                    <span className="sr-only">Change priority for {title}</span>
                    <select
                      value={priority}
                      disabled={priorityUpdating}
                      onChange={(event) => void onPriorityChange(taskId, event.target.value as TaskPriority)}
                      aria-label={'Change priority for ' + title}
                    >
                      {priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                </> : <>
                  <span className={'task-friendly-status task-friendly-status--' + status}>{humanizeStatus(status)}</span>
                  <span className={'task-friendly-priority task-friendly-priority--' + priority}>{humanize(priority)}</span>
                </>}
              </div>
            </div>

            <div className="task-friendly-meta">
              <span title={project}><FolderKanban size={14} aria-hidden="true" />{project}</span>
              <span title={assignee}><UserRound size={14} aria-hidden="true" />{assignee}</span>
            </div>
          </div>

          <div className={'task-friendly-due ' + due.className}>
            <Clock3 size={15} aria-hidden="true" />
            <div>
              <span className="task-friendly-due__date">{due.dateLabel}</span>
              <strong>{due.relativeLabel}</strong>
            </div>
          </div>


        </article>;
      })}
    </div>

    <div className="task-friendly-pagination" aria-label="Task pages">
      <span>Page <strong>{page}</strong> of <strong>{Math.max(1, pages)}</strong></span>
      <div>
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} /> Previous</button>
        <button type="button" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>Next <ChevronRight size={16} /></button>
      </div>
    </div>
  </section>;
}

function normalizeStatus(value: unknown): TaskStatus {
  const status = stringValue(value).toLowerCase();
  if (status === 'in_progress' || status === 'review' || status === 'completed' || status === 'blocked') return status;
  return 'pending';
}

function normalizePriority(value: unknown): 'urgent' | 'high' | 'normal' | 'low' {
  const priority = stringValue(value).toLowerCase();
  if (priority === 'urgent' || priority === 'high' || priority === 'low') return priority;
  return 'normal';
}

function dueMeta(value: unknown): { dateLabel: string; relativeLabel: string; className: string } {
  const raw = stringValue(value);
  if (!raw) return { dateLabel: 'No due date', relativeLabel: 'Schedule when ready', className: 'task-friendly-due--none' };

  const parsed = parseDateOnly(raw);
  if (!parsed) return { dateLabel: raw, relativeLabel: 'Due date', className: 'task-friendly-due--none' };

  const today = new Date();
  const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dueDate = new Date(parsed.year, parsed.month - 1, parsed.day);
  const days = Math.round((dueDate.getTime() - todayDate.getTime()) / 86_400_000);
  const dateLabel = dueDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

  if (days < 0) return { dateLabel, relativeLabel: Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' overdue', className: 'task-friendly-due--overdue' };
  if (days === 0) return { dateLabel, relativeLabel: 'Due today', className: 'task-friendly-due--today' };
  if (days <= 2) return { dateLabel, relativeLabel: days + ' day' + (days === 1 ? '' : 's') + ' left', className: 'task-friendly-due--soon' };
  if (days <= 5) return { dateLabel, relativeLabel: days + ' days left', className: 'task-friendly-due--watch' };
  return { dateLabel, relativeLabel: days + ' days left', className: 'task-friendly-due--safe' };
}

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function humanizeStatus(value: TaskStatus): string {
  return value === 'in_progress' ? 'In progress' : humanize(value);
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

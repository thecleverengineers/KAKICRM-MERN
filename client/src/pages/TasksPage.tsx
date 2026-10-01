import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Check, ChevronDown, Plus, Search, Trash2, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TaskFriendlyList } from '../components/TaskFriendlyList.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { TaskRecycleBinDialog } from '../components/TaskRecycleBinDialog.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { type TaskStatus } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';
import '../styles/task-kanban.css';
import '../styles/task-friendly.css';

const taskResource: ResourceConfig = {
  id: 'tasks', label: 'Tasks', singular: 'Task', description: 'Assignments, workload, daily updates, discussions, files and time tracking.', icon: Plus, permission: 'task.view',
  columns: ['title', 'status', 'priority', 'assignee_ids', 'due_date', 'project_id'], searchFields: ['title', 'description', 'status', 'priority'],
  fields: [{ key: 'title', label: 'Task title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'in_progress', 'review', 'completed', 'blocked'] }, { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'normal', 'high', 'urgent'] }, { key: 'due_date', label: 'Due date', kind: 'date' }, { key: 'assignee_ids', label: 'Assign to employees', kind: 'multiRelation', relation: 'users' }, { key: 'team_id', label: 'Team', kind: 'relation', relation: 'teams' }, { key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments' }, { key: 'project_id', label: 'Project', kind: 'relation', relation: 'department_projects' }]
};

type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

type TaskStatusFilter = 'all' | TaskStatus;
type TaskDateFilter = 'all' | 'overdue' | 'today' | 'next7' | 'next30' | 'custom';

const taskDateOptions: Array<{ id: TaskDateFilter; label: string }> = [
  { id: 'all', label: 'All dates' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'next7', label: 'Next 7 days' },
  { id: 'next30', label: 'Next 30 days' },
  { id: 'custom', label: 'Custom range' }
];

const taskPriorityOptions: Array<{ id: 'all' | TaskPriority; label: string }> = [
  { id: 'all', label: 'All priorities' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' }
];

const taskStatusTabs: Array<{ id: TaskStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'pending', label: 'Pending' },
  { id: 'completed', label: 'Completed' },
  { id: 'blocked', label: 'Blocked' }
];

function isoLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftLocalDate(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return isoLocalDate(date);
}

function taskDueDateRange(filter: TaskDateFilter, customFrom: string, customTo: string): { dueFrom?: string; dueTo?: string } {
  if (filter === 'overdue') return { dueTo: shiftLocalDate(-1) };
  if (filter === 'today') {
    const today = shiftLocalDate(0);
    return { dueFrom: today, dueTo: today };
  }
  if (filter === 'next7') return { dueFrom: shiftLocalDate(0), dueTo: shiftLocalDate(6) };
  if (filter === 'next30') return { dueFrom: shiftLocalDate(0), dueTo: shiftLocalDate(29) };
  if (filter === 'custom') return {
    ...(customFrom ? { dueFrom: customFrom } : {}),
    ...(customTo ? { dueTo: customTo } : {})
  };
  return {};
}

// Keep the task filter presentation local to this page. This also makes the
// status navigation resilient when an older cached global stylesheet is still
// present while the rest of the application assets are being refreshed.
export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [suggestionTerm, setSuggestionTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [recycleConfirmOpen, setRecycleConfirmOpen] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [recycling, setRecycling] = useState(false);
  const [recycleError, setRecycleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<TaskStatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [dateFilter, setDateFilter] = useState<TaskDateFilter>('all');
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [statusUpdatingId, setStatusUpdatingId] = useState<number | null>(null);
  const [priorityUpdatingId, setPriorityUpdatingId] = useState<number | null>(null);
  const dueDateRange = useMemo(() => taskDueDateRange(dateFilter, customDateFrom, customDateTo), [dateFilter, customDateFrom, customDateTo]);
  const hasActiveFilters = Boolean(search || priorityFilter !== 'all' || dateFilter !== 'all');
  const statusCountsQuery = useQuery({
    queryKey: ['task-status-counts', dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const counts = await Promise.all(taskStatusTabs.map(async (tab) => {
        const result = await api<Paginated<PublicRecord>>(`/tasks${queryString({
          page: 1,
          limit: 1,
          ...(tab.id !== 'all' ? { status: tab.id } : {}),
          ...dueDateRange
        })}`);
        return [tab.id, result.pagination.total] as const;
      }));
      return Object.fromEntries(counts) as Record<TaskStatusFilter, number>;
    }
  });
  useEffect(() => {
    const term = searchInput.trim();
    if (term.length < 2) {
      setSuggestionTerm('');
      return;
    }
    const timer = window.setTimeout(() => setSuggestionTerm(term), 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  const canManage = hasPermission('task.manage');
  const isEmployee = user?.role?.trim().toLowerCase() === 'employee';
  const canCreate = canManage || isEmployee;
  const initialTaskFields = useMemo(() => ({ status: 'pending', priority: 'normal', ...(isEmployee && user?.legacyId ? { assignee_ids: [user.legacyId] } : {}) }), [isEmployee, user?.legacyId]);
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (!canCreate) return;
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [canCreate, searchParams, setSearchParams]);
  useEffect(() => {
    setSelectedTaskIds([]);
    setRecycleError(null);
  }, [page, search, activeStatus, priorityFilter, dateFilter, customDateFrom, customDateTo]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const query = useQuery({
    queryKey: ['tasks', page, search, activeStatus, priorityFilter, dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({
      page,
      limit: 50,
      search,
      ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
      ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {}),
      ...dueDateRange
    })}`),
    placeholderData: keepPreviousData
  });
  const suggestionsQuery = useQuery({
    queryKey: ['task-suggestions', suggestionTerm, activeStatus, priorityFilter, dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    enabled: searchOpen && suggestionTerm.length >= 1,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({
      page: 1,
      limit: 6,
      search: suggestionTerm,
      ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
      ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {}),
      ...dueDateRange
    })}`)
  });
  const applySearch = (value = searchInput) => {
    const nextSearch = value.trim();
    setSearchInput(nextSearch);
    setSearch(nextSearch);
    setPage(1);
    setSearchOpen(false);
  };
  if (query.isPending) return <LoadingState label="Loading tasks…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const invalidateTaskViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['task-status-counts'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['project-departments'] }),
      queryClient.invalidateQueries({ queryKey: ['department-project-board'] }),
      queryClient.invalidateQueries({ queryKey: ['project-workspace'] }),
      queryClient.invalidateQueries({ queryKey: ['team-workspace'] }),
      queryClient.invalidateQueries({ queryKey: ['employee-workspace'] }),
      queryClient.invalidateQueries({ queryKey: ['live-workforce'] })
    ]);
  };
  const create = async (fields: Record<string, unknown>) => {
    await api('/tasks', { method: 'POST', body: JSON.stringify(fields) });
    await invalidateTaskViews();
  };

  const updateTaskStatus = async (taskId: number, status: TaskStatus) => {
    if (statusUpdatingId === taskId) return;
    setStatusUpdatingId(taskId);
    setNotice(null);
    try {
      await api(`/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setNotice(`Task status changed to ${status.replace(/_/g, ' ')}.`);
      await invalidateTaskViews();
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : 'The task status could not be updated.');
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const updateTaskPriority = async (taskId: number, priority: TaskPriority) => {
    if (priorityUpdatingId === taskId) return;
    setPriorityUpdatingId(taskId);
    setNotice(null);
    try {
      await api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ priority }) });
      setNotice(`Task priority changed to ${priority}.`);
      await invalidateTaskViews();
    } catch (problem) {
      setNotice(problem instanceof Error ? problem.message : 'The task priority could not be updated.');
    } finally {
      setPriorityUpdatingId(null);
    }
  };

  const recycleSelected = async () => {
    if (!selectedTaskIds.length || recycling) return;
    setRecycling(true);
    setRecycleError(null);
    try {
      const result = await api<{ data: { recycledTaskIds: number[]; count: number } }>('/tasks/recycle', {
        method: 'POST',
        body: JSON.stringify({ taskIds: selectedTaskIds })
      });
      const recycledCount = result.data.count;
      setSelectedTaskIds([]);
      setRecycleConfirmOpen(false);
      setNotice(`${recycledCount} task${recycledCount === 1 ? '' : 's'} moved to Task Recycle.`);
      await invalidateTaskViews();
    } catch (problem) {
      setRecycleError(problem instanceof Error ? problem.message : 'The selected tasks could not be moved to recycle.');
    } finally {
      setRecycling(false);
    }
  };

  return <>
    <PageHeader eyebrow="WORK MANAGEMENT" title="Tasks" description={isEmployee ? 'See what needs attention, update progress quickly and keep your assigned work moving.' : 'See what needs attention, assign work and move tasks through the workflow without digging through a dense table.'} actions={canCreate ? <><>{canManage && <button className="button button--secondary" onClick={() => setRecycleBinOpen(true)}><ArchiveRestore size={17} /> Task recycle</button>}</><button className="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> New task</button></> : undefined} />
    <div className="task-status-tabs" role="tablist" aria-label="Tasks by status">
      {taskStatusTabs.map((tab) => <button className={activeStatus === tab.id ? 'task-status-tab is-active' : 'task-status-tab'} data-status={tab.id} key={tab.id} type="button" role="tab" aria-selected={activeStatus === tab.id} onClick={() => { setActiveStatus(tab.id); setPage(1); }}>
        <span className="task-status-tab__dot" aria-hidden="true" />
        <span>{tab.label}</span>
        <span className="task-status-count" aria-label={`${statusCountsQuery.data?.[tab.id] ?? 0} tasks`}>{statusCountsQuery.isPending ? '·' : statusCountsQuery.data?.[tab.id] ?? 0}</span>
      </button>)}
    </div>
    <div className="toolbar task-toolbar task-toolbar--records">
      <div className="task-search-area" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false); }}>
        <form className="task-search-form" onSubmit={(event) => { event.preventDefault(); applySearch(); }}>
          <label className="search-box"><Search size={17} /><input value={searchInput} onFocus={() => setSearchOpen(true)} onChange={(event) => { setSearchInput(event.target.value); setSearchOpen(true); }} placeholder="Search task or assignee…" aria-label="Search task or assignee" aria-autocomplete="list" aria-expanded={searchOpen} /></label>
          <button className="button button--secondary button--compact task-search-submit" type="submit">Search</button>
        </form>
        {searchOpen && searchInput.trim().length >= 1 && <div className="task-search-suggestions" role="listbox" aria-label="Task suggestions">
          {suggestionTerm !== searchInput.trim() || suggestionsQuery.isFetching ? <p className="task-search-message">Finding suggestions…</p> : suggestionsQuery.data?.data.length ? suggestionsQuery.data.data.map((record) => {
            const title = String(record.fields.title ?? 'Untitled task');
            const taskId = record.legacyId;
            const assignees = record.relationLabels?.assignee_ids ?? record.relationLabels?.assignee_id;
            return <button className="task-search-suggestion" type="button" role="option" aria-selected="false" key={record.id} onClick={() => { setSearchOpen(false); if (taskId) navigate('/tasks/' + taskId); }}>
              <span className="task-search-suggestion__title">{title}</span>
              <span className="task-search-suggestion__meta">{String(record.fields.status ?? 'pending').replace(/_/g, ' ')} · {String(record.fields.priority ?? 'normal')} priority{assignees ? ' · ' + assignees : ''}</span>
            </button>;
          }) : <p className="task-search-message">No matching tasks found.</p>}
          <button className="task-search-all" type="button" onClick={() => applySearch()}>Show all results for “{searchInput.trim()}”</button>
        </div>}
      </div>
      <div className="task-priority-filter" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPriorityMenuOpen(false); }}><span className="task-priority-filter__label">Priority</span><span className={priorityMenuOpen ? 'task-priority-select is-open' : 'task-priority-select'} data-priority={priorityFilter}><button className="task-priority-trigger" type="button" aria-haspopup="listbox" aria-expanded={priorityMenuOpen} onClick={() => setPriorityMenuOpen((open) => !open)}><span className="task-priority-select__dot" aria-hidden="true" /><span className="task-priority-trigger__text">{taskPriorityOptions.find((option) => option.id === priorityFilter)?.label ?? 'All priorities'}</span><ChevronDown className="task-priority-select__chevron" size={16} aria-hidden="true" /></button>{priorityMenuOpen && <div className="task-priority-menu" role="listbox" aria-label="Filter tasks by priority">{taskPriorityOptions.map((option) => <button className={priorityFilter === option.id ? 'task-priority-option is-selected' : 'task-priority-option'} data-priority={option.id} type="button" role="option" aria-selected={priorityFilter === option.id} key={option.id} onClick={() => { setPriorityFilter(option.id); setPage(1); setPriorityMenuOpen(false); }}><span className="task-priority-option__dot" aria-hidden="true" /><span>{option.label}</span>{priorityFilter === option.id ? <Check className="task-priority-option__check" size={15} aria-hidden="true" /> : <span />}</button>)}</div>}</span></div>
      <div className="task-date-filter"><div className="task-date-filter__wrap"><CalendarDays size={16} aria-hidden="true" /><select className="task-date-filter__control" value={dateFilter} aria-label="Filter tasks by due date" onChange={(event) => { setDateFilter(event.target.value as TaskDateFilter); setPage(1); }}>{taskDateOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div></div>
      <div className="task-toolbar-actions">{canManage && selectedTaskIds.length > 0 && <><span className="task-selection-count">{selectedTaskIds.length} selected</span><button className="button button--danger button--compact" type="button" onClick={() => { setRecycleError(null); setRecycleConfirmOpen(true); }}><Trash2 size={16} /> Move to recycle</button><button className="text-button" type="button" onClick={() => setSelectedTaskIds([])}>Clear</button></>}<span className={query.isFetching && !query.isPending ? 'task-filter-refreshing is-visible' : 'task-filter-refreshing'} role="status" aria-live="polite">{query.isFetching && !query.isPending ? 'Updating…' : ''}</span><span className="task-visible-count">{query.data.pagination.total} {isEmployee ? 'in your work circle' : 'visible to you'}</span></div>
    </div>
    {dateFilter === 'custom' && <div className="task-custom-date-range" aria-label="Custom due date range">
      <label className="field"><span>Due from</span><input type="date" value={customDateFrom} max={customDateTo || undefined} onChange={(event) => { setCustomDateFrom(event.target.value); setPage(1); }} /></label>
      <label className="field"><span>Due to</span><input type="date" value={customDateTo} min={customDateFrom || undefined} onChange={(event) => { setCustomDateTo(event.target.value); setPage(1); }} /></label>
      <span className="task-custom-date-range__copy">Leave either side empty for an open-ended range.</span>
    </div>}
    <div className={hasActiveFilters ? 'task-filter-state-row' : 'task-filter-state-row is-empty'}>{hasActiveFilters && <div className="task-active-filters" aria-label="Active task filters">
      {search && <span className="task-active-filter">Search: {search}<button type="button" aria-label="Clear search" onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}>×</button></span>}
      {priorityFilter !== 'all' && <span className="task-active-filter">Priority: {taskPriorityOptions.find((option) => option.id === priorityFilter)?.label}<button type="button" aria-label="Clear priority filter" onClick={() => { setPriorityFilter('all'); setPage(1); }}>×</button></span>}
      {dateFilter !== 'all' && <span className="task-active-filter">Due date: {dateFilter === 'custom' ? [customDateFrom || 'Any', customDateTo || 'Any'].join(' → ') : taskDateOptions.find((option) => option.id === dateFilter)?.label}<button type="button" aria-label="Clear due date filter" onClick={() => { setDateFilter('all'); setCustomDateFrom(''); setCustomDateTo(''); setPage(1); }}>×</button></span>}
      <button className="task-clear-filters" type="button" onClick={() => { setSearch(''); setSearchInput(''); setPriorityFilter('all'); setDateFilter('all'); setCustomDateFrom(''); setCustomDateTo(''); setPage(1); }}>Clear filters</button>

    </div>}</div>
    {notice && <p className="task-action-notice" role="status">{notice}</p>}
    <TaskFriendlyList
      records={query.data.data}
      page={query.data.pagination.page}
      pages={query.data.pagination.pages}
      total={query.data.pagination.total}
      onPageChange={setPage}
      onOpen={(record) => { if (record.legacyId) navigate('/tasks/' + record.legacyId); }}
      selectable={canManage}
      selectedLegacyIds={selectedTaskIds}
      onSelectedLegacyIdsChange={setSelectedTaskIds}
      onStatusChange={updateTaskStatus}
      onPriorityChange={updateTaskPriority}
      statusUpdatingId={statusUpdatingId}
      priorityUpdatingId={priorityUpdatingId}
      emptyTitle={activeStatus === 'all' ? 'You’re all caught up' : 'No tasks in this status'}
    />
    <RecordFormDialog open={createOpen} resource={taskResource} initialFields={initialTaskFields} onClose={() => setCreateOpen(false)} onSubmit={create} />
    <TaskRecycleBinDialog open={recycleBinOpen} onClose={() => setRecycleBinOpen(false)} onRestored={async (restoredCount) => { setNotice(`${restoredCount} task${restoredCount === 1 ? '' : 's'} restored from Task Recycle.`); await invalidateTaskViews(); }} />
    {recycleConfirmOpen && <TaskRecycleConfirmDialog count={selectedTaskIds.length} recycling={recycling} error={recycleError} onClose={() => { if (!recycling) setRecycleConfirmOpen(false); }} onConfirm={() => void recycleSelected()} />}
  </>;
}

function TaskRecycleConfirmDialog({ count, recycling, error, onClose, onConfirm }: { count: number; recycling: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal task-recycle-confirm-modal" role="dialog" aria-modal="true" aria-label="Move tasks to recycle" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><p className="eyebrow">TASK RECYCLE</p><h2>Move selected tasks?</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={recycling} aria-label="Close"><X size={18} /></button></div>
    <p className="invoice-delete-copy"><strong>{count} task{count === 1 ? '' : 's'}</strong> will disappear from active task lists, project Kanban boards, team workflows and employee assignments.</p>
    <p className="task-recycle-note">Nothing is permanently deleted. Each task, its files, comments, time logs and history remains intact in Task Recycle until you restore it.</p>
    {error && <p className="form-error">{error}</p>}
    <div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={recycling}>Cancel</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={recycling}><Trash2 size={16} /> {recycling ? 'Moving…' : 'Move to recycle'}</button></div>
  </section></div>;
}

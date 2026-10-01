import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
const taskStatusTabsStyle = `
.task-status-tabs { width: 100%; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0; padding: 6px 10px; margin: 0 0 18px; border: 0; border-radius: 14px; background: linear-gradient(135deg, rgba(255,255,255,.72), rgba(244,248,252,.56)); box-shadow: none; backdrop-filter: blur(18px) saturate(135%); -webkit-backdrop-filter: blur(18px) saturate(135%); }
button.task-status-tab { position: relative; min-width: 0; min-height: 46px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; appearance: none; background: transparent; color: #66758a; font: inherit; font-size: .76rem; font-weight: 800; letter-spacing: .01em; white-space: nowrap; cursor: pointer; box-shadow: none; transition: color .16s ease, border-color .16s ease, background-color .16s ease; }
button.task-status-tab:hover { background: rgba(255,255,255,.34); color: #2f4058; }
button.task-status-tab:focus-visible { outline: 2px solid rgba(78,117,174,.24); outline-offset: -2px; }
button.task-status-tab.is-active { border-bottom-color: #315c9e; background: rgba(255,255,255,.42); color: #274d82; box-shadow: none; transform: none; }
.task-status-tab__dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #9aa8bb; box-shadow: 0 0 0 3px rgba(154, 168, 187, .14); }
.task-status-tab[data-status="pending"] .task-status-tab__dot { background: #d99b2b; box-shadow: 0 0 0 3px rgba(217, 155, 43, .14); }
.task-status-tab[data-status="in_progress"] .task-status-tab__dot { background: #4f7dd4; box-shadow: 0 0 0 3px rgba(79, 125, 212, .14); }
.task-status-tab[data-status="review"] .task-status-tab__dot { background: #8a66c7; box-shadow: 0 0 0 3px rgba(138, 102, 199, .14); }
.task-status-tab[data-status="completed"] .task-status-tab__dot { background: #39a66b; box-shadow: 0 0 0 3px rgba(57, 166, 107, .14); }
.task-status-tab[data-status="blocked"] .task-status-tab__dot { background: #d15d68; box-shadow: 0 0 0 3px rgba(209, 93, 104, .14); }
.task-status-tab.is-active .task-status-tab__dot { transform: scale(1.08); }
.task-priority-filter { position: relative; z-index: 35; display: flex; align-items: center; gap: 9px; min-width: 0; overflow: visible; }
.task-priority-filter__label { color: #6f7d91; font-size: .69rem; font-weight: 800; letter-spacing: .055em; text-transform: uppercase; white-space: nowrap; }
.task-priority-select { position: relative; min-width: 168px; height: 42px; display: flex; align-items: center; gap: 9px; padding: 0 38px 0 12px; overflow: visible; border: 1px solid #d8e1ec; border-radius: 12px; background: linear-gradient(180deg,#ffffff 0%,#f8fafd 100%); box-shadow: 0 5px 14px rgba(33,52,82,.06), inset 0 1px 0 rgba(255,255,255,.9); transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; z-index: 30; }
.task-priority-select:hover { border-color: #b8c7da; box-shadow: 0 8px 20px rgba(33,52,82,.09), inset 0 1px 0 rgba(255,255,255,.95); transform: translateY(-1px); }
.task-priority-select:focus-within { border-color: #7f9ed1; box-shadow: 0 0 0 3px rgba(75,118,183,.12), 0 8px 20px rgba(33,52,82,.08); }
.task-priority-select__dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 0 4px rgba(148,163,184,.12); }
.task-priority-select[data-priority="urgent"] .task-priority-select__dot { background: #dc2626; box-shadow: 0 0 0 4px rgba(220,38,38,.10); }
.task-priority-select[data-priority="high"] .task-priority-select__dot { background: #f97316; box-shadow: 0 0 0 4px rgba(249,115,22,.11); }
.task-priority-select[data-priority="normal"] .task-priority-select__dot { background: #3b82f6; box-shadow: 0 0 0 4px rgba(59,130,246,.11); }
.task-priority-select[data-priority="low"] .task-priority-select__dot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.11); }
.task-priority-trigger { width: 100%; height: 100%; min-width: 0; padding: 0; display: flex; align-items: center; gap: 9px; border: 0; outline: 0; background: transparent; color: #26364f; font: inherit; font-size: .77rem; font-weight: 750; text-align: left; cursor: pointer; }
.task-priority-trigger__text { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-priority-select__chevron { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); color: #7f8ea3; pointer-events: none; transition: transform .16s ease, color .16s ease; }
.task-priority-select.is-open .task-priority-select__chevron { transform: translateY(-50%) rotate(180deg); color: #496da7; }
.task-priority-menu { position: absolute; z-index: 999; top: calc(100% + 9px); right: 0; width: 100%; min-width: 190px; padding: 7px; overflow: visible; border: 1px solid #d8e1ec; border-radius: 14px; background: rgba(255,255,255,.98); box-shadow: 0 18px 42px rgba(23,42,70,.16), 0 4px 12px rgba(23,42,70,.08); backdrop-filter: blur(14px); }
.task-priority-option { width: 100%; min-height: 42px; padding: 0 10px; display: grid; grid-template-columns: 12px minmax(0,1fr) 18px; align-items: center; gap: 9px; border: 0; border-radius: 9px; background: transparent; color: #33445e; font: inherit; font-size: .76rem; font-weight: 750; text-align: left; cursor: pointer; transition: background-color .14s ease, color .14s ease, transform .14s ease; }
.task-priority-option:hover, .task-priority-option:focus-visible { outline: none; background: #f3f6fb; color: #1f3352; transform: translateX(1px); }
.task-priority-option.is-selected { background: #edf3fb; color: #274d82; }
.task-priority-option__dot { width: 9px; height: 9px; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 0 4px rgba(148,163,184,.10); }
.task-priority-option[data-priority="urgent"] .task-priority-option__dot { background: #dc2626; box-shadow: 0 0 0 4px rgba(220,38,38,.09); }
.task-priority-option[data-priority="high"] .task-priority-option__dot { background: #f97316; box-shadow: 0 0 0 4px rgba(249,115,22,.10); }
.task-priority-option[data-priority="normal"] .task-priority-option__dot { background: #3b82f6; box-shadow: 0 0 0 4px rgba(59,130,246,.10); }
.task-priority-option[data-priority="low"] .task-priority-option__dot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.10); }
.task-priority-option__check { color: #3d67a2; justify-self: end; }
.task-date-filter { min-width: 178px; display: flex; align-items: center; gap: 8px; }
.task-date-filter__wrap { position: relative; min-width: 0; }
.task-date-filter__control { width: 100%; height: 42px; min-width: 178px; padding: 0 34px 0 36px; border: 1px solid #d8e1ec; border-radius: 12px; outline: 0; appearance: none; background: linear-gradient(180deg,#ffffff 0%,#f8fafd 100%); color: #26364f; font: inherit; font-size: .75rem; font-weight: 750; cursor: pointer; box-shadow: 0 5px 14px rgba(33,52,82,.06); transition: border-color .16s ease, box-shadow .16s ease; }
.task-date-filter__wrap > svg:first-child { position: absolute; z-index: 1; left: 12px; top: 50%; transform: translateY(-50%); color: #70829b; pointer-events: none; }
.task-date-filter__wrap > svg:last-child { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); color: #7f8ea3; pointer-events: none; }
.task-date-filter__control:hover { border-color: #b8c7da; }
.task-date-filter__control:focus { border-color: #7f9ed1; box-shadow: 0 0 0 3px rgba(75,118,183,.12), 0 8px 20px rgba(33,52,82,.08); }
.task-custom-date-range { width: 100%; margin: -5px 0 14px; padding: 12px; display: flex; align-items: end; flex-wrap: wrap; gap: 10px; border: 1px solid #e0e7f0; border-radius: 12px; background: #fbfcfe; }
.task-custom-date-range .field { flex: 1 1 170px; }
.task-custom-date-range .field input { background: #fff; }
.task-custom-date-range__copy { flex: 0 0 auto; padding-bottom: 10px; color: #8190a3; font-size: .68rem; }

@media (max-width: 760px) {
  .task-status-tabs { display: flex; grid-template-columns: none; gap: 6px; padding: 6px; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .task-status-tabs::-webkit-scrollbar { height: 6px; }
  .task-status-tabs::-webkit-scrollbar-thumb { border-radius: 999px; background: #c7d3e2; }
  button.task-status-tab { flex: 0 0 auto; min-width: 112px; min-height: 42px; padding: 0 12px; font-size: .72rem; scroll-snap-align: start; }
  .task-status-tab__dot { width: 7px; height: 7px; }
}
@media (max-width: 430px) {
  button.task-status-tab { min-width: 106px; justify-content: center; padding: 0 10px; }
}
.task-records-responsive { width: 100%; min-width: 0; max-width: 100%; overflow: hidden; }
.task-records-responsive .table-card { width: 100%; max-width: 100%; overflow: hidden; border: 0; border-radius: 0; box-shadow: none; background: transparent; }
.task-records-responsive .table-scroll { width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-gutter: stable; background: #fff; }
.task-records-responsive .table-scroll::-webkit-scrollbar { height: 8px; }
.task-records-responsive .table-scroll::-webkit-scrollbar-track { background: #f3f6fa; }
.task-records-responsive .table-scroll::-webkit-scrollbar-thumb { border-radius: 999px; background: #c4cfdd; }
.task-records-responsive .table-scroll table { width: 100%; min-width: 1040px; table-layout: fixed; }
.task-records-responsive th,
.task-records-responsive td { min-width: 0; overflow: hidden; }
.task-records-responsive .table-select-cell { width: 42px; }
.task-records-responsive .table-id { width: 60px; }
.task-records-responsive [data-column="title"] { width: 26%; }
.task-records-responsive [data-column="status"] { width: 105px; }
.task-records-responsive [data-column="priority"] { width: 86px; }
.task-records-responsive [data-column="assignee_ids"] { width: 19%; }
.task-records-responsive [data-column="due_date"] { width: 118px; }
.task-records-responsive [data-column="project_id"] { width: 18%; }
.task-records-responsive .table-actions { width: 48px; }
.task-records-responsive td .truncate-cell { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-records-responsive .pagination { border-top: 1px solid #edf0f4; background: #fff; }
@media (max-width: 760px) {
  .task-records-responsive .table-scroll table { min-width: 980px; }
  .task-records-responsive .pagination { gap: 12px; overflow-x: auto; white-space: nowrap; }
  .task-toolbar--records { align-items: stretch; }
  .task-toolbar--records .task-search-area { flex: 1 1 100%; max-width: none; }
  .task-search-form { min-width: 0; }
  .task-priority-filter { flex: 1 1 auto; min-width: 0; }
  .task-priority-select { min-width: 150px; max-width: 100%; }
  .task-date-filter { flex: 1 1 auto; min-width: 0; }
  .task-date-filter__wrap, .task-date-filter__control { width: 100%; min-width: 150px; }
  .task-toolbar-actions { width: 100%; justify-content: flex-start; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .task-toolbar-actions > * { flex: 0 0 auto; }
  .task-toolbar-actions::-webkit-scrollbar { height: 5px; }
  .task-toolbar-actions::-webkit-scrollbar-thumb { border-radius: 999px; background: #c7d3e2; }
}
`;

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
  const statusCountsQuery = useQuery({
    queryKey: ['task-status-counts', dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    staleTime: 30_000,
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
  const query = useQuery({
    queryKey: ['tasks', page, search, activeStatus, priorityFilter, dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({
      page,
      limit: 50,
      search,
      ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
      ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {}),
      ...dueDateRange
    })}`)
  });
  const suggestionsQuery = useQuery({
    queryKey: ['task-suggestions', suggestionTerm, activeStatus, priorityFilter, dueDateRange.dueFrom ?? '', dueDateRange.dueTo ?? ''],
    enabled: searchOpen && suggestionTerm.length >= 1,
    staleTime: 30_000,
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

  return <><style>{taskStatusTabsStyle}</style>
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
      <div className="task-toolbar-actions">{canManage && selectedTaskIds.length > 0 && <><span className="task-selection-count">{selectedTaskIds.length} selected</span><button className="button button--danger button--compact" type="button" onClick={() => { setRecycleError(null); setRecycleConfirmOpen(true); }}><Trash2 size={16} /> Move to recycle</button><button className="text-button" type="button" onClick={() => setSelectedTaskIds([])}>Clear</button></>}{query.data.pagination.total} {isEmployee ? 'in your work circle' : 'visible to you'}</div>
    </div>
    {dateFilter === 'custom' && <div className="task-custom-date-range" aria-label="Custom due date range">
      <label className="field"><span>Due from</span><input type="date" value={customDateFrom} max={customDateTo || undefined} onChange={(event) => { setCustomDateFrom(event.target.value); setPage(1); }} /></label>
      <label className="field"><span>Due to</span><input type="date" value={customDateTo} min={customDateFrom || undefined} onChange={(event) => { setCustomDateTo(event.target.value); setPage(1); }} /></label>
      <span className="task-custom-date-range__copy">Leave either side empty for an open-ended range.</span>
    </div>}
    {(search || priorityFilter !== 'all' || dateFilter !== 'all') && <div className="task-active-filters" aria-label="Active task filters">
      {search && <span className="task-active-filter">Search: {search}<button type="button" aria-label="Clear search" onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}>×</button></span>}
      {priorityFilter !== 'all' && <span className="task-active-filter">Priority: {taskPriorityOptions.find((option) => option.id === priorityFilter)?.label}<button type="button" aria-label="Clear priority filter" onClick={() => { setPriorityFilter('all'); setPage(1); }}>×</button></span>}
      {dateFilter !== 'all' && <span className="task-active-filter">Due date: {dateFilter === 'custom' ? [customDateFrom || 'Any', customDateTo || 'Any'].join(' → ') : taskDateOptions.find((option) => option.id === dateFilter)?.label}<button type="button" aria-label="Clear due date filter" onClick={() => { setDateFilter('all'); setCustomDateFrom(''); setCustomDateTo(''); setPage(1); }}>×</button></span>}
      <button className="task-clear-filters" type="button" onClick={() => { setSearch(''); setSearchInput(''); setPriorityFilter('all'); setDateFilter('all'); setCustomDateFrom(''); setCustomDateTo(''); setPage(1); }}>Clear filters</button>
    </div>}
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

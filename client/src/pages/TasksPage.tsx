import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, Plus, Search, Trash2, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { TaskRecycleBinDialog } from '../components/TaskRecycleBinDialog.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { type TaskStatus } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';
import '../styles/task-kanban.css';

const taskResource: ResourceConfig = {
  id: 'tasks', label: 'Tasks', singular: 'Task', description: 'Assignments, workload, daily updates, discussions, files and time tracking.', icon: Plus, permission: 'task.view',
  columns: ['title', 'status', 'priority', 'assignee_ids', 'due_date', 'project_id'], searchFields: ['title', 'description', 'status', 'priority'],
  fields: [{ key: 'title', label: 'Task title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'in_progress', 'review', 'completed', 'blocked'] }, { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'normal', 'high', 'urgent'] }, { key: 'due_date', label: 'Due date', kind: 'date' }, { key: 'assignee_ids', label: 'Assign to employees', kind: 'multiRelation', relation: 'users' }, { key: 'team_id', label: 'Team', kind: 'relation', relation: 'teams' }, { key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments' }, { key: 'project_id', label: 'Project', kind: 'relation', relation: 'department_projects' }]
};

type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

type TaskStatusFilter = 'all' | TaskStatus;

const taskStatusTabs: Array<{ id: TaskStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Completed' },
  { id: 'blocked', label: 'Blocked' }
];
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
  }, [page, search, activeStatus, priorityFilter]);
  const query = useQuery({
    queryKey: ['tasks', page, search, activeStatus, priorityFilter],
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({
      page,
      limit: 50,
      search,
      ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
      ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {})
    })}`)
  });
  const suggestionsQuery = useQuery({
    queryKey: ['task-suggestions', suggestionTerm, activeStatus, priorityFilter],
    enabled: searchOpen && suggestionTerm.length >= 1,
    staleTime: 30_000,
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({
      page: 1,
      limit: 6,
      search: suggestionTerm,
      ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
      ...(priorityFilter !== 'all' ? { priority: priorityFilter } : {})
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
    <PageHeader eyebrow="WORK MANAGEMENT" title="Tasks" description={isEmployee ? 'Tasks you own, are assigned to, mentioned in, or tagged in are shown here. You can assign work to one or more employees.' : 'Keep projects moving with ownership, progress updates, task chat and time logs.'} actions={canCreate ? <><>{canManage && <button className="button button--secondary" onClick={() => setRecycleBinOpen(true)}><ArchiveRestore size={17} /> Task recycle</button>}</><button className="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> New task</button></> : undefined} />
    <div className="task-status-tabs" role="tablist" aria-label="Tasks by status">
      {taskStatusTabs.map((tab) => <button className={activeStatus === tab.id ? 'task-status-tab is-active' : 'task-status-tab'} key={tab.id} type="button" role="tab" aria-selected={activeStatus === tab.id} onClick={() => { setActiveStatus(tab.id); setPage(1); }}>{tab.label}</button>)}
    </div>
    <div className="toolbar task-toolbar task-toolbar--records">
      <div className="task-search-area" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false); }}>
        <form className="task-search-form" onSubmit={(event) => { event.preventDefault(); applySearch(); }}>
          <label className="search-box"><Search size={17} /><input value={searchInput} onFocus={() => setSearchOpen(true)} onChange={(event) => { setSearchInput(event.target.value); setSearchOpen(true); }} placeholder="Search tasks…" aria-label="Search tasks" aria-autocomplete="list" aria-expanded={searchOpen} /></label>
          <button className="button button--secondary button--compact task-search-submit" type="submit">Search</button>
        </form>
        {searchOpen && searchInput.trim().length >= 1 && <div className="task-search-suggestions" role="listbox" aria-label="Task suggestions">
          {suggestionTerm !== searchInput.trim() || suggestionsQuery.isFetching ? <p className="task-search-message">Finding suggestions…</p> : suggestionsQuery.data?.data.length ? suggestionsQuery.data.data.map((record) => {
            const title = String(record.fields.title ?? 'Untitled task');
            const taskId = record.legacyId;
            return <button className="task-search-suggestion" type="button" role="option" aria-selected="false" key={record.id} onClick={() => { setSearchOpen(false); if (taskId) navigate('/tasks/' + taskId); }}>
              <span className="task-search-suggestion__title">{title}</span>
              <span className="task-search-suggestion__meta">{String(record.fields.status ?? 'pending').replace(/_/g, ' ')} · {String(record.fields.priority ?? 'normal')} priority</span>
            </button>;
          }) : <p className="task-search-message">No matching tasks found.</p>}
          <button className="task-search-all" type="button" onClick={() => applySearch()}>Show all results for “{searchInput.trim()}”</button>
        </div>}
      </div>
      <label className="task-priority-filter"><span>Priority</span><select value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value as 'all' | TaskPriority); setPage(1); }} aria-label="Filter tasks by priority"><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
      <div className="task-toolbar-actions">{canManage && selectedTaskIds.length > 0 && <><span className="task-selection-count">{selectedTaskIds.length} selected</span><button className="button button--danger button--compact" type="button" onClick={() => { setRecycleError(null); setRecycleConfirmOpen(true); }}><Trash2 size={16} /> Move to recycle</button><button className="text-button" type="button" onClick={() => setSelectedTaskIds([])}>Clear</button></>}{query.data.pagination.total} {isEmployee ? 'in your work circle' : 'visible to you'}</div>
    </div>
    {notice && <p className="task-action-notice" role="status">{notice}</p>}
    <DataTable records={query.data.data} columns={taskResource.columns} resource={taskResource} page={query.data.pagination.page} pages={query.data.pagination.pages} total={query.data.pagination.total} onPageChange={setPage} onOpen={(record) => navigate('/tasks/' + record.legacyId)} clickableRows selectable={canManage} selectedLegacyIds={selectedTaskIds} onSelectedLegacyIdsChange={setSelectedTaskIds} emptyTitle={activeStatus === 'all' ? 'No tasks found' : 'No tasks in this status'} />
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

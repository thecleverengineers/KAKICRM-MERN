import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Columns3, List, Plus, Search, Trash2, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable } from '../components/DataTable.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { TaskRecycleBinDialog } from '../components/TaskRecycleBinDialog.js';
import { type ResourceConfig } from '../config/resources.js';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { date, displayValue } from '../lib/format.js';
import { taskStatus as normalizeTaskStatus, type TaskStatus } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';
import '../styles/task-kanban.css';

const taskResource: ResourceConfig = {
  id: 'tasks', label: 'Tasks', singular: 'Task', description: 'Assignments, workload, daily updates, discussions, files and time tracking.', icon: Plus, permission: 'task.view',
  columns: ['title', 'status', 'priority', 'assignee_ids', 'due_date', 'project_id'], searchFields: ['title', 'description', 'status', 'priority'],
  fields: [{ key: 'title', label: 'Task title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'in_progress', 'review', 'completed', 'blocked'] }, { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'normal', 'high', 'urgent'] }, { key: 'due_date', label: 'Due date', kind: 'date' }, { key: 'assignee_ids', label: 'Assign to employees', kind: 'multiRelation', relation: 'users' }, { key: 'team_id', label: 'Team', kind: 'relation', relation: 'teams' }, { key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments' }, { key: 'project_id', label: 'Project', kind: 'relation', relation: 'department_projects' }]
};

type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

const taskBoardColumns: Array<{ id: TaskStatus; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Completed' },
  { id: 'blocked', label: 'Blocked' }
];
const taskPriorityRank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
function normalizeTaskPriority(value: unknown): TaskPriority {
  const priority = String(value ?? '').trim().toLowerCase();
  return priority === 'urgent' || priority === 'high' || priority === 'low' ? priority : 'normal';
}

export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [recycleConfirmOpen, setRecycleConfirmOpen] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [recycling, setRecycling] = useState(false);
  const [recycleError, setRecycleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [movingTaskId, setMovingTaskId] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const canManage = hasPermission('task.manage');
  const isEmployee = user?.role?.trim().toLowerCase() === 'employee';
  const canUpdateStatus = isEmployee || canManage || hasPermission('projects.manage') || hasPermission('departments.manage') || hasPermission('teams.manage');
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
  }, [page, search]);
  const query = useQuery({ queryKey: ['tasks', page, search], queryFn: () => api<Paginated<PublicRecord>>(`/tasks${queryString({ page, limit: 50, search })}`) });
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
  const moveTask = async (taskId: number, status: TaskStatus) => {
    if (!canUpdateStatus || movingTaskId !== null) return;
    setMovingTaskId(taskId);
    setMoveError(null);
    try {
      await api('/tasks/' + taskId + '/status', { method: 'PATCH', body: JSON.stringify({ status }) });
      await invalidateTaskViews();
    } catch (problem) {
      setMoveError(problem instanceof Error ? problem.message : 'Unable to move this task.');
    } finally {
      setMovingTaskId(null);
    }
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

  const boardTasks = query.data.data
    .filter((record) => priorityFilter === 'all' || normalizeTaskPriority(record.fields.priority) === priorityFilter)
    .sort((left, right) => {
      const priorityDifference = taskPriorityRank[normalizeTaskPriority(left.fields.priority)] - taskPriorityRank[normalizeTaskPriority(right.fields.priority)];
      if (priorityDifference !== 0) return priorityDifference;
      const leftDue = String(left.fields.due_date ?? '');
      const rightDue = String(right.fields.due_date ?? '');
      if (!leftDue) return rightDue ? 1 : 0;
      if (!rightDue) return -1;
      return leftDue.localeCompare(rightDue);
    });

  return <>
    <PageHeader eyebrow="WORK MANAGEMENT" title="Tasks" description={isEmployee ? 'Tasks you own, are assigned to, mentioned in, or tagged in are shown here. You can assign work to one or more employees.' : 'Keep projects moving with ownership, progress updates, task chat and time logs.'} actions={canCreate ? <><>{canManage && <button className="button button--secondary" onClick={() => setRecycleBinOpen(true)}><ArchiveRestore size={17} /> Task recycle</button>}</><button className="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> New task</button></> : undefined} />
    <div className="task-view-tabs" role="tablist" aria-label="Task views">
      <button className={view === 'board' ? 'task-view-tab is-active' : 'task-view-tab'} type="button" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')}><Columns3 size={16} /> Kanban board</button>
      <button className={view === 'list' ? 'task-view-tab is-active' : 'task-view-tab'} type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}><List size={16} /> List</button>
    </div>
    <div className="toolbar task-toolbar task-toolbar--kanban">
      <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search tasks…" /></label>
      {view === 'board' && <label className="task-priority-filter"><span>Priority</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as 'all' | TaskPriority)} aria-label="Filter tasks by priority"><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>}
      <div className="task-toolbar-actions">{canManage && selectedTaskIds.length > 0 && <><span className="task-selection-count">{selectedTaskIds.length} selected</span><button className="button button--danger button--compact" type="button" onClick={() => { setRecycleError(null); setRecycleConfirmOpen(true); }}><Trash2 size={16} /> Move to recycle</button><button className="text-button" type="button" onClick={() => setSelectedTaskIds([])}>Clear</button></>}{query.data.pagination.total} {isEmployee ? 'in your work circle' : 'visible to you'}</div>
    </div>
    {notice && <p className="task-action-notice" role="status">{notice}</p>}
    {moveError && <p className="form-error task-kanban-error" role="alert">{moveError}</p>}
    {view === 'board' ? <>
      <div className="kanban-board task-kanban-board" aria-label="Tasks grouped by status">
        {taskBoardColumns.map((column) => {
          const columnTasks = boardTasks.filter((record) => normalizeTaskStatus(record.fields.status) === column.id);
          return <section className={'kanban-column task-kanban-column task-kanban-column--' + column.id} key={column.id} onDragOver={(event) => { if (canUpdateStatus) event.preventDefault(); }} onDrop={(event) => {
            if (!canUpdateStatus) return;
            event.preventDefault();
            const taskId = Number(event.dataTransfer.getData('application/kaki-task-id'));
            if (Number.isInteger(taskId) && taskId > 0) void moveTask(taskId, column.id);
          }}>
            <header><div><span>{column.label}</span><b>{columnTasks.length}</b></div></header>
            <div className="kanban-column__items">
              {columnTasks.map((record) => {
                const taskId = record.legacyId;
                const priority = normalizeTaskPriority(record.fields.priority);
                const assignees = record.relationLabels?.assignee_ids ?? record.relationLabels?.assignee_id ?? '';
                const title = displayValue(record.fields.title);
                return <article className={'kanban-task-card task-kanban-card ' + (movingTaskId === taskId ? 'kanban-project-card--moving' : '')} key={record.id} draggable={canUpdateStatus && Boolean(taskId)} onDragStart={(event) => { if (taskId) event.dataTransfer.setData('application/kaki-task-id', String(taskId)); }} onClick={() => { if (taskId) navigate('/tasks/' + taskId); }} tabIndex={0} role="button" aria-label={title + ', ' + priority + ' priority, ' + column.label} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && taskId) navigate('/tasks/' + taskId); }}>
                  <div className="kanban-task-card__top"><span className={'task-priority-pill task-priority-pill--' + priority}>{priority}</span><span><CalendarDays size={13} /> {record.fields.due_date ? date(record.fields.due_date) : 'No due date'}</span></div>
                  <h3>{title}</h3>
                  {Boolean(record.fields.description) && <p>{displayValue(record.fields.description)}</p>}
                  <footer><span>{assignees || 'Unassigned'}</span><small>{movingTaskId === taskId ? 'Moving…' : canUpdateStatus ? 'Drag to move' : 'Open task'}</small></footer>
                </article>;
              })}
              {!columnTasks.length && <div className="kanban-empty">{priorityFilter === 'all' ? 'No tasks' : 'No matching tasks'}</div>}
            </div>
          </section>;
        })}
      </div>
      {query.data.pagination.pages > 1 && <nav className="task-kanban-pagination" aria-label="Task board pages"><button className="button button--secondary button--compact" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button><span>Page {query.data.pagination.page} of {query.data.pagination.pages}</span><button className="button button--secondary button--compact" type="button" disabled={page >= query.data.pagination.pages} onClick={() => setPage((current) => Math.min(query.data.pagination.pages, current + 1))}>Next</button></nav>}
    </> : <DataTable records={query.data.data} columns={taskResource.columns} resource={taskResource} page={query.data.pagination.page} pages={query.data.pagination.pages} total={query.data.pagination.total} onPageChange={setPage} onOpen={(record) => navigate('/tasks/' + record.legacyId)} clickableRows selectable={canManage} selectedLegacyIds={selectedTaskIds} onSelectedLegacyIdsChange={setSelectedTaskIds} />}
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

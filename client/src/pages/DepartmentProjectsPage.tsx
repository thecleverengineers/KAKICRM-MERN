import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, CircleCheckBig, GripVertical, Plus, UsersRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { StatusPill } from '../components/StatusPill.js';
import { useAuth } from '../store/auth.js';
import { api } from '../lib/api.js';
import { date, displayValue } from '../lib/format.js';
import { departmentProjectResource, humanize, PROJECT_KANBAN_COLUMNS, projectStatus, type DepartmentBoard, type ProjectStatus } from '../lib/projects.js';

export function DepartmentProjectsPage() {
  const { departmentId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { hasPermission } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [movingId, setMovingId] = useState<number | null>(null);
  const canManage = hasPermission('departments.manage') || hasPermission('projects.manage');
  const query = useQuery({
    queryKey: ['department-project-board', departmentId],
    enabled: Boolean(departmentId),
    queryFn: () => api<DepartmentBoard>(`/projects/departments/${departmentId}`)
  });
  if (query.isPending) return <LoadingState label="Loading department project board…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const board = query.data;
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['department-project-board', departmentId] }),
      client.invalidateQueries({ queryKey: ['project-departments'] })
    ]);
  };
  const moveProject = async (projectId: number, status: ProjectStatus) => {
    if (!canManage || movingId === projectId) return;
    const project = board.projects.find((item) => item.data.legacyId === projectId);
    if (!project || projectStatus(project.data.fields.status) === status) return;
    setMovingId(projectId);
    try {
      await api(`/projects/${projectId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refresh();
    } finally {
      setMovingId(null);
    }
  };
  const createProject = async (fields: Record<string, unknown>) => {
    await api(`/projects/departments/${departmentId}/projects`, { method: 'POST', body: JSON.stringify(fields) });
    await refresh();
  };

  return <>
    <PageHeader eyebrow="DEPARTMENT KANBAN" title={displayValue(board.department.data.fields.name)} description={board.department.head.name ? `Department head · ${board.department.head.name}` : 'Set a department head to make accountability visible here.'} actions={<><button className="button button--secondary" onClick={() => navigate('/data/departments')}><ArrowLeft size={17} /> All departments</button>{canManage && <button className="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> Add project</button>}</>} />
    <section className="department-analytics-grid" aria-label="Department project analytics">
      <article><span>Projects</span><strong>{board.analytics.totalProjects}</strong><small>{board.analytics.projectsByStatus.active} active</small></article>
      <article><span>Task completion</span><strong>{board.analytics.taskCompletionRate}%</strong><small>{board.analytics.completedTasks} of {board.analytics.totalTasks} done</small></article>
      <article><span>On hold</span><strong>{board.analytics.projectsByStatus.on_hold}</strong><small>Projects requiring attention</small></article>
      <article><span>Overdue tasks</span><strong>{board.analytics.overdueTasks}</strong><small>Across department projects</small></article>
    </section>

    <section className="kanban-board project-kanban-board" aria-label={`${displayValue(board.department.data.fields.name)} project Kanban board`}>
      {PROJECT_KANBAN_COLUMNS.map((column) => {
        const projects = board.projects.filter((project) => projectStatus(project.data.fields.status) === column.id);
        return <section className={`kanban-column kanban-column--${column.id}`} key={column.id} onDragOver={(event) => { if (canManage) event.preventDefault(); }} onDrop={(event) => {
          event.preventDefault();
          const projectId = Number(event.dataTransfer.getData('application/kaki-project-id'));
          if (projectId) void moveProject(projectId, column.id);
        }}>
          <header><div><span>{column.label}</span><b>{projects.length}</b></div>{canManage && <small>Drop here</small>}</header>
          <div className="kanban-column__items">
            {projects.map((project) => <article className={`kanban-project-card ${movingId === project.data.legacyId ? 'kanban-project-card--moving' : ''}`} draggable={canManage} key={project.data.id} onDragStart={(event) => event.dataTransfer.setData('application/kaki-project-id', String(project.data.legacyId))} onClick={() => navigate(`/data/departments/${departmentId}/projects/${project.data.legacyId}`)} tabIndex={0} role="button" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/data/departments/${departmentId}/projects/${project.data.legacyId}`); }}>
              <div className="kanban-project-card__heading"><StatusPill value={humanize(column.id)} /><GripVertical size={17} className="kanban-project-card__grip" /></div>
              <h3>{displayValue(project.data.fields.name)}</h3>
              {project.data.fields.description ? <p>{displayValue(project.data.fields.description)}</p> : <p className="muted-copy">No project note yet.</p>}
              <div className="kanban-project-card__meta"><span><UsersRound size={14} /> {displayValue(project.data.relationLabels?.lead_user_id ?? project.data.fields.lead_user_id)}</span><span><CalendarDays size={14} /> {date(project.data.fields.end_date)}</span></div>
              <footer><span><CircleCheckBig size={14} /> {project.analytics.completedTasks}/{project.analytics.totalTasks} tasks</span><button type="button" className="text-button" onClick={(event) => { event.stopPropagation(); navigate(`/data/departments/${departmentId}/projects/${project.data.legacyId}`); }}>Open</button></footer>
            </article>)}
            {!projects.length && <div className="kanban-empty">No projects</div>}
          </div>
        </section>;
      })}
    </section>
    <RecordFormDialog open={createOpen} resource={departmentProjectResource} initialFields={{ status: 'planned' }} onClose={() => setCreateOpen(false)} onSubmit={createProject} />
  </>;
}

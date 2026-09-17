import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BarChart3, BriefcaseBusiness, CircleCheckBig, Layers3, Plus, Settings2, UsersRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { api } from '../lib/api.js';
import { resourceById } from '../config/resources.js';
import { displayValue } from '../lib/format.js';
import type { DepartmentSummary } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';

export function ProjectsPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { hasPermission } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const canManageDepartments = hasPermission('departments.manage');
  const departmentResource = resourceById.get('departments');
  const query = useQuery({ queryKey: ['project-departments'], queryFn: () => api<{ data: DepartmentSummary[] }>('/projects/departments') });
  if (query.isPending) return <LoadingState label="Loading department projects…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const departments = [...query.data.data].sort((left, right) => displayValue(left.data.fields.name).localeCompare(displayValue(right.data.fields.name)));
  const totalProjects = departments.reduce((sum, department) => sum + department.analytics.totalProjects, 0);
  const activeProjects = departments.reduce((sum, department) => sum + department.analytics.projectsByStatus.active, 0);
  const totalTasks = departments.reduce((sum, department) => sum + department.analytics.totalTasks, 0);
  const completeTasks = departments.reduce((sum, department) => sum + department.analytics.completedTasks, 0);
  const completionRate = totalTasks ? Math.round((completeTasks / totalTasks) * 100) : 0;
  const createDepartment = async (fields: Record<string, unknown>) => {
    await api('/records/departments', { method: 'POST', body: JSON.stringify({ fields }) });
    await client.invalidateQueries({ queryKey: ['project-departments'] });
  };

  return <>
    <PageHeader eyebrow="DEPARTMENT OPERATIONS" title="Departments" description="Each department is a live project card. Open one to manage its Kanban board, team, tasks, files, project head and notes." actions={canManageDepartments ? <><button className="button button--secondary" onClick={() => navigate('/data/departments/manage')}><Settings2 size={17} /> Manage departments</button><button className="button" onClick={() => setCreateOpen(true)}><Plus size={17} /> New department</button></> : undefined} />
    <section className="project-overview-grid" aria-label="Project analytics">
      <button type="button" className="project-overview-card project-overview-card--interactive project-overview-card--indigo" onClick={() => navigate('/data/department_projects')} aria-label={`View and manage all ${totalProjects} projects`}><span className="project-overview-icon"><BriefcaseBusiness size={20} /></span><div><small>Total projects</small><strong>{totalProjects}</strong><p>Across {departments.length} department{departments.length === 1 ? '' : 's'}</p><span className="project-overview-card__link">View all projects <ArrowRight size={15} aria-hidden="true" /></span></div></button>
      <button type="button" className="project-overview-card project-overview-card--interactive project-overview-card--green" onClick={() => navigate('/data/department_projects?status=active')} aria-label={`View and manage ${activeProjects} active projects`}><span className="project-overview-icon"><Layers3 size={20} /></span><div><small>Active projects</small><strong>{activeProjects}</strong><p>Currently in progress</p><span className="project-overview-card__link">View active projects <ArrowRight size={15} aria-hidden="true" /></span></div></button>
      <button type="button" className="project-overview-card project-overview-card--interactive project-overview-card--amber" onClick={() => navigate('/tasks')} aria-label={`View all ${totalTasks} project tasks`}><span className="project-overview-icon"><BarChart3 size={20} /></span><div><small>Project tasks</small><strong>{totalTasks}</strong><p>{completeTasks} completed</p><span className="project-overview-card__link">View all tasks <ArrowRight size={15} aria-hidden="true" /></span></div></button>
      <article className="project-overview-card project-overview-card--blue"><span className="project-overview-icon"><CircleCheckBig size={20} /></span><div><small>Task completion</small><strong>{completionRate}%</strong><p>Across all departments</p></div></article>
    </section>

    <section className="department-projects-section">
      <div className="section-heading"><div><p className="eyebrow">DEPARTMENT KANBAN</p><h2>Choose a department</h2><p>Each full card opens that department’s project Kanban board.</p></div><span>{departments.length} total</span></div>
      <div className="department-projects-grid">
        {departments.map((department) => <button type="button" className="department-project-card" key={department.data.id} onClick={() => navigate(`/data/departments/${department.data.legacyId}/projects`)}>
          <span className="department-project-card__top"><span className="department-project-mark">{initials(department.data.fields.name)}</span><span className="department-project-open">Open <ArrowRight size={16} /></span></span>
          <span className="department-project-card__copy"><strong>{displayValue(department.data.fields.name)}</strong><small>{department.head.name ? `Department head · ${department.head.name}` : 'Department head not assigned'}</small></span>
          <span className="department-project-card__stats"><span><BriefcaseBusiness size={15} /><b>{department.analytics.totalProjects}</b> project{department.analytics.totalProjects === 1 ? '' : 's'}</span><span><UsersRound size={15} /><b>{department.analytics.totalTasks}</b> task{department.analytics.totalTasks === 1 ? '' : 's'}</span></span>
          <span className="department-project-progress"><span><i style={{ width: `${department.analytics.taskCompletionRate}%` }} /></span><small>{department.analytics.taskCompletionRate}% task completion</small></span>
        </button>)}
      </div>
    </section>
    {departmentResource && <RecordFormDialog open={createOpen} resource={departmentResource} onClose={() => setCreateOpen(false)} onSubmit={createDepartment} />}
  </>;
}

function initials(value: unknown): string {
  return String(value ?? 'D').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'D';
}

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BriefcaseBusiness, CheckSquare, CircleCheckBig, Pencil, Plus, UserMinus, UserPlus, UserRoundCheck, UsersRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { StatusPill } from '../components/StatusPill.js';
import { resourceById } from '../config/resources.js';
import { api, type PublicRecord } from '../lib/api.js';
import { date, displayValue } from '../lib/format.js';
import { humanize, TASK_KANBAN_COLUMNS, taskStatus, type TaskStatus } from '../lib/projects.js';
import { teamMemberResource, type TeamWorkspace } from '../lib/teams.js';
import { useAuth } from '../store/auth.js';

export function TeamWorkspacePage() {
  const { teamId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('teams.manage');
  const canOpenProjects = hasPermission('departments.view') || hasPermission('departments.manage') || hasPermission('projects.view') || hasPermission('projects.manage');
  const [memberOpen, setMemberOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [teamEditOpen, setTeamEditOpen] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<number | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['team-workspace', teamId],
    enabled: Boolean(teamId),
    queryFn: () => api<TeamWorkspace>(`/teams/${teamId}`)
  });
  const teamResource = resourceById.get('teams');

  if (query.isPending) return <LoadingState label="Loading team workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const workspace = query.data;
  const teamName = displayValue(workspace.data.fields.name);
  const leader = displayValue(workspace.data.relationLabels?.leader_id ?? workspace.data.fields.leader_id);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['team-workspace', teamId] }),
      client.invalidateQueries({ queryKey: ['records', 'teams'] }),
      client.invalidateQueries({ queryKey: ['project-workspace'] })
    ]);
  };
  const createMember = async (fields: Record<string, unknown>) => {
    await api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify(fields) });
    await refresh();
  };
  const removeMember = async (member: PublicRecord) => {
    const name = displayValue(member.relationLabels?.user_id ?? member.fields.user_id);
    if (!member.legacyId || !window.confirm(`Remove ${name} from ${teamName}? Their membership is archived, not permanently deleted.`)) return;
    setRemovingMemberId(member.legacyId);
    setActionError(null);
    try {
      await api(`/teams/${teamId}/members/${member.legacyId}`, { method: 'DELETE' });
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to remove this team member.');
    } finally {
      setRemovingMemberId(null);
    }
  };
  const moveTask = async (taskId: number, status: TaskStatus) => {
    if (!canManage || movingTaskId === taskId) return;
    const task = workspace.tasks.find((item) => item.legacyId === taskId);
    if (!task || taskStatus(task.fields.status) === status) return;
    setMovingTaskId(taskId);
    setActionError(null);
    try {
      await api(`/teams/${teamId}/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to update this team task.');
    } finally {
      setMovingTaskId(null);
    }
  };
  const createTask = async (fields: Record<string, unknown>) => {
    await api(`/teams/${teamId}/tasks`, { method: 'POST', body: JSON.stringify(fields) });
    await refresh();
  };
  const saveTeam = async (fields: Record<string, unknown>) => {
    await api(`/records/teams/${teamId}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
    await refresh();
  };

  return <>
    <PageHeader eyebrow="TEAM WORKSPACE" title={teamName} description={leader === '—' ? 'Assign team members, coordinate work and follow the team workflow.' : `Team leader · ${leader}`} actions={<><button className="button button--secondary" onClick={() => navigate('/data/teams')}><ArrowLeft size={17} /> All teams</button>{canManage && <><button className="button button--secondary" onClick={() => setTeamEditOpen(true)}><Pencil size={17} /> Edit team</button><button className="button button--secondary" onClick={() => setMemberOpen(true)}><UserPlus size={17} /> Assign member</button><button className="button" onClick={() => setTaskOpen(true)}><Plus size={17} /> Add team task</button></>}</>} />

    <section className="team-workspace-summary" aria-label="Team analytics">
      <article><span className="project-summary-icon"><UsersRound size={18} /></span><div><small>Assigned members</small><strong>{workspace.analytics.memberCount}</strong></div></article>
      <article><span className="project-summary-icon"><UserRoundCheck size={18} /></span><div><small>Team leader</small><strong>{leader}</strong></div></article>
      <article><span className="project-summary-icon"><BriefcaseBusiness size={18} /></span><div><small>Active projects</small><strong>{workspace.analytics.activeProjects}/{workspace.analytics.totalProjects}</strong></div></article>
      <article><span className="project-summary-icon"><CircleCheckBig size={18} /></span><div><small>Workflow completion</small><strong>{workspace.analytics.taskCompletionRate}%</strong></div></article>
    </section>
    {actionError && <p className="project-action-error">{actionError}</p>}

    <article className="team-workflow-card content-card">
      <div className="card-heading"><div><p className="eyebrow">TEAM WORKFLOW</p><h2>Task Kanban</h2><p className="team-card-description">Every team task and task from an assigned project stays visible here.</p></div><span className="soft-count">{workspace.analytics.totalTasks} tasks</span></div>
      <div className="kanban-board team-task-kanban" aria-label={`${teamName} task Kanban board`}>
        {TASK_KANBAN_COLUMNS.map((column) => {
          const tasks = workspace.tasks.filter((task) => taskStatus(task.fields.status) === column.id);
          return <section className={`kanban-column kanban-column--team-${column.id}`} key={column.id} onDragOver={(event) => { if (canManage) event.preventDefault(); }} onDrop={(event) => {
            event.preventDefault();
            const taskId = Number(event.dataTransfer.getData('application/kaki-team-task-id'));
            if (taskId) void moveTask(taskId, column.id);
          }}>
            <header><div><span>{column.label}</span><b>{tasks.length}</b></div>{canManage && <small>Drop here</small>}</header>
            <div className="kanban-column__items">
              {tasks.map((task) => <article className={`kanban-task-card ${movingTaskId === task.legacyId ? 'kanban-project-card--moving' : ''}`} draggable={canManage} key={task.id} onDragStart={(event) => event.dataTransfer.setData('application/kaki-team-task-id', String(task.legacyId))} onClick={() => navigate(`/tasks/${task.legacyId}`)} tabIndex={0} role="button" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/tasks/${task.legacyId}`); }}>
                <div className="kanban-task-card__top"><StatusPill value={task.fields.priority} /><span>{date(task.fields.due_date)}</span></div>
                <h3>{displayValue(task.fields.title)}</h3>
                <p>{displayValue(task.fields.description)}</p>
                <footer><span>{displayValue(task.relationLabels?.assignee_ids ?? task.relationLabels?.assignee_id ?? task.fields.assignee_ids ?? task.fields.assignee_id)}</span><small>{displayValue(task.relationLabels?.project_id ?? 'Team task')}</small></footer>
              </article>)}
              {!tasks.length && <div className="kanban-empty">No tasks</div>}
            </div>
          </section>;
        })}
      </div>
    </article>

    <section className="team-workspace-layout">
      <article className="team-members-card content-card">
        <div className="card-heading"><div><p className="eyebrow">ASSIGNED TEAM MEMBERS</p><h2>People on this team</h2><p className="team-card-description">Add employees here once; they become available for team tasks and any project using this team.</p></div>{canManage && <button className="button button--secondary" onClick={() => setMemberOpen(true)}><UserPlus size={16} /> Assign member</button>}</div>
        <div className="team-member-list">
          {workspace.members.map((member) => <div className="team-member-row" key={member.id}><span className="team-member-avatar">{initials(member.relationLabels?.user_id ?? member.fields.user_id)}</span><div><strong>{displayValue(member.relationLabels?.user_id ?? member.fields.user_id)}</strong><small>{displayValue(member.fields.role_in_team) === '—' ? 'Team member' : displayValue(member.fields.role_in_team)}</small></div>{canManage && <button className="text-button team-member-remove" onClick={() => void removeMember(member)} disabled={removingMemberId === member.legacyId}>{removingMemberId === member.legacyId ? 'Removing…' : <><UserMinus size={14} /> Remove</>}</button>}</div>)}
          {!workspace.members.length && <div className="team-members-empty"><UsersRound size={20} /><strong>No members assigned</strong><span>Use “Assign member” to add employees to this team.</span></div>}
        </div>
      </article>

      <article className="team-profile-card content-card"><div className="card-heading"><div><p className="eyebrow">TEAM PROFILE</p><h2>Leadership and purpose</h2></div><UsersRound size={19} /></div><dl className="team-profile-list"><div><dt>Team leader</dt><dd>{leader}</dd></div><div><dt>Assigned members</dt><dd>{workspace.analytics.memberCount}</dd></div><div><dt>Open work</dt><dd>{workspace.analytics.totalTasks - workspace.analytics.completedTasks} tasks</dd></div><div><dt>Overdue</dt><dd>{workspace.analytics.overdueTasks} tasks</dd></div></dl><p className="team-profile-note">{displayValue(workspace.data.fields.description) === '—' ? 'No team description has been added.' : displayValue(workspace.data.fields.description)}</p></article>
    </section>

    <article className="team-projects-card content-card">
      <div className="card-heading"><div><p className="eyebrow">ASSIGNED PROJECTS</p><h2>Projects using this team</h2></div><span className="soft-count">{workspace.analytics.totalProjects} projects</span></div>
      <div className="team-project-list">
        {workspace.projects.map((project) => {
          const departmentId = Number(project.data.fields.department_id);
          const canOpen = canOpenProjects && Number.isSafeInteger(departmentId) && departmentId > 0 && project.data.legacyId;
          const content = <><div><StatusPill value={humanize(String(project.data.fields.status ?? 'planned'))} /><h3>{displayValue(project.data.fields.name)}</h3><p>{displayValue(project.data.fields.description)}</p></div><footer><span><CheckSquare size={14} /> {project.analytics.completedTasks}/{project.analytics.totalTasks} tasks</span><span>{project.analytics.taskCompletionRate}% complete</span></footer></>;
          return canOpen ? <button type="button" key={project.data.id} className="team-project-item" onClick={() => navigate(`/data/departments/${departmentId}/projects/${project.data.legacyId}`)}>{content}</button> : <article key={project.data.id} className="team-project-item team-project-item--static">{content}</article>;
        })}
        {!workspace.projects.length && <div className="team-project-empty"><BriefcaseBusiness size={20} /><strong>No projects assigned</strong><span>Assign this team from a project workspace to connect work here.</span></div>}
      </div>
    </article>

    <RecordFormDialog open={memberOpen} resource={teamMemberResource} initialFields={{ role_in_team: 'Team member' }} onClose={() => setMemberOpen(false)} onSubmit={createMember} />
    {teamResource && <RecordFormDialog open={teamEditOpen} resource={teamResource} record={workspace.data} onClose={() => setTeamEditOpen(false)} onSubmit={saveTeam} />}
    <TeamTaskDialog open={taskOpen} assignees={workspace.assignees} onClose={() => setTaskOpen(false)} onSubmit={createTask} />
  </>;
}

function TeamTaskDialog({ open, assignees, onClose, onSubmit }: { open: boolean; assignees: Array<{ id: number; name: string }>; onClose: () => void; onSubmit: (fields: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueDate, setDueDate] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setPriority('normal');
    setDueDate('');
    setAssigneeIds([]);
    setSaving(false);
    setError(null);
  }, [open]);
  if (!open) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ title, description: description.trim() || null, priority, due_date: dueDate || null, assignee_ids: assigneeIds.map(Number), status: 'pending' });
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Unable to create the team task.');
    } finally {
      setSaving(false);
    }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label="Add team task" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">TEAM WORKFLOW</p><h2>Add team task</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div><form onSubmit={(event) => void submit(event)}><div className="form-grid"><label className="field field--wide"><span>Task title *</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label className="field field--wide"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label><label className="field"><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value)}>{['low', 'normal', 'high', 'urgent'].map((value) => <option value={value} key={value}>{humanize(value)}</option>)}</select></label><label className="field"><span>Due date</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label className="field field--wide"><span>Assign to team members</span><select multiple size={Math.min(8, Math.max(4, assignees.length))} value={assigneeIds} onChange={(event) => setAssigneeIds(Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}>{assignees.map((assignee) => <option value={assignee.id} key={assignee.id}>{assignee.name}</option>)}</select><small>Hold Ctrl/Cmd to select multiple team members.</small></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button type="submit" className="button" disabled={saving}>{saving ? 'Creating…' : 'Create task'}</button></div></form></section></div>;
}

function initials(value: unknown): string {
  return String(value ?? 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}

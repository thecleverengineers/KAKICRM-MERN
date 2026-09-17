import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, CheckSquare, FileText, FolderKanban, Plus, Save, Upload, UserRoundCheck, UsersRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { RecordFormDialog } from '../components/RecordFormDialog.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, type RelationOption } from '../lib/api.js';
import { date, dateTime, displayValue } from '../lib/format.js';
import { humanize, projectTaskResource, TASK_KANBAN_COLUMNS, taskStatus, type ProjectWorkspace, type TaskStatus } from '../lib/projects.js';
import { useAuth } from '../store/auth.js';

interface ProjectLookups {
  teams: RelationOption[];
  users: RelationOption[];
}

export function ProjectWorkspacePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('departments.manage') || hasPermission('projects.manage');
  const [taskOpen, setTaskOpen] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [projectHeadId, setProjectHeadId] = useState('');
  const [projectStatusValue, setProjectStatusValue] = useState('planned');
  const [note, setNote] = useState('');
  const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [movingTaskId, setMovingTaskId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['project-workspace', projectId], enabled: Boolean(projectId), queryFn: () => api<ProjectWorkspace>(`/projects/${projectId}`) });
  const lookupsQuery = useQuery({
    queryKey: ['project-workspace-lookups'],
    enabled: canManage,
    staleTime: 60_000,
    queryFn: async () => {
      const [teams, users] = await Promise.all([
        api<{ data: RelationOption[] }>('/records/lookups/department_projects/teams'),
        api<{ data: RelationOption[] }>('/records/lookups/department_projects/users')
      ]);
      return { teams: teams.data, users: users.data } satisfies ProjectLookups;
    }
  });

  useEffect(() => {
    if (!query.data) return;
    setTeamId(stringValue(query.data.data.fields.team_id));
    setProjectHeadId(stringValue(query.data.data.fields.lead_user_id));
    setProjectStatusValue(String(query.data.data.fields.status ?? 'planned'));
    setNote(String(query.data.data.fields.description ?? ''));
  }, [query.data]);

  if (query.isPending) return <LoadingState label="Loading project workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const workspace = query.data;
  const departmentId = workspace.department?.legacyId;
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['project-workspace', projectId] }),
      client.invalidateQueries({ queryKey: ['department-project-board', departmentId] }),
      client.invalidateQueries({ queryKey: ['project-departments'] })
    ]);
  };
  const saveSettings = async () => {
    if (!canManage) return;
    setSavingSettings(true);
    setActionError(null);
    try {
      await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          team_id: teamId ? Number(teamId) : null,
          lead_user_id: projectHeadId ? Number(projectHeadId) : null,
          status: projectStatusValue
        })
      });
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to save project settings.');
    } finally {
      setSavingSettings(false);
    }
  };
  const saveNote = async () => {
    if (!canManage) return;
    setSavingNote(true);
    setActionError(null);
    try {
      await api(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ description: note.trim() || null }) });
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to save the project note.');
    } finally {
      setSavingNote(false);
    }
  };
  const moveTask = async (taskId: number, status: TaskStatus) => {
    if (!canManage || movingTaskId === taskId) return;
    const task = workspace.tasks.find((item) => item.legacyId === taskId);
    if (!task || taskStatus(task.fields.status) === status) return;
    setMovingTaskId(taskId);
    setActionError(null);
    try {
      await api(`/projects/${projectId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to update the task.');
    } finally {
      setMovingTaskId(null);
    }
  };
  const createTask = async (fields: Record<string, unknown>) => {
    await api(`/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(fields) });
    await refresh();
  };
  const uploadFiles = async () => {
    if (!canManage || !filesToUpload.length) return;
    setUploadingFiles(true);
    setActionError(null);
    try {
      const formData = new FormData();
      filesToUpload.forEach((file) => formData.append('files', file));
      await api(`/projects/${projectId}/files`, { method: 'POST', body: formData });
      setFilesToUpload([]);
      await refresh();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'Unable to upload project files.');
    } finally {
      setUploadingFiles(false);
    }
  };

  return <>
    <PageHeader eyebrow="PROJECT WORKSPACE" title={displayValue(workspace.data.fields.name)} description={workspace.department ? `${displayValue(workspace.department.fields.name)} · ${displayValue(workspace.data.fields.status).replaceAll('_', ' ')}` : 'Project workspace'} actions={<><button className="button button--secondary" onClick={() => navigate(departmentId ? `/data/departments/${departmentId}/projects` : '/data/departments')}><ArrowLeft size={17} /> Back to department</button>{canManage && <button className="button" onClick={() => setTaskOpen(true)}><Plus size={17} /> Add task</button>}</>} />
    <section className="project-workspace-summary" aria-label="Project overview">
      <article><span className="project-summary-icon"><UserRoundCheck size={18} /></span><div><small>Project head</small><strong>{workspace.projectHead.name ?? displayValue(workspace.data.relationLabels?.lead_user_id ?? workspace.data.fields.lead_user_id)}</strong></div></article>
      <article><span className="project-summary-icon"><UsersRound size={18} /></span><div><small>Assigned team</small><strong>{workspace.team ? displayValue(workspace.team.fields.name) : 'No team assigned'}</strong></div></article>
      <article><span className="project-summary-icon"><CheckSquare size={18} /></span><div><small>Task completion</small><strong>{workspace.analytics.taskCompletionRate}%</strong></div></article>
      <article><span className="project-summary-icon"><CalendarDays size={18} /></span><div><small>Target date</small><strong>{date(workspace.data.fields.end_date)}</strong></div></article>
    </section>
    {actionError && <p className="project-action-error">{actionError}</p>}

    <section className="project-workspace-layout">
      <div className="project-workspace-main">
        <article className="project-note-card content-card">
          <div className="card-heading"><div><p className="eyebrow">PROJECT NOTE</p><h2>Brief, decisions and next steps</h2></div><FileText size={19} /></div>
          {canManage ? <><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add the project brief, decisions, scope, blockers or next steps…" rows={6} /><div className="project-card-actions"><span>Visible to everyone with project access.</span><button className="button" onClick={() => void saveNote()} disabled={savingNote}><Save size={16} /> {savingNote ? 'Saving…' : 'Save note'}</button></div></> : <p className="project-note-display">{note || 'No project note has been added.'}</p>}
        </article>

        <article className="project-task-board-card content-card">
          <div className="card-heading"><div><p className="eyebrow">PROJECT TASKS</p><h2>Delivery Kanban</h2></div><span className="soft-count">{workspace.analytics.totalTasks} tasks</span></div>
          <div className="kanban-board task-kanban-board" aria-label="Project task Kanban board">
            {TASK_KANBAN_COLUMNS.map((column) => {
              const tasks = workspace.tasks.filter((task) => taskStatus(task.fields.status) === column.id);
              return <section className={`kanban-column kanban-column--task-${column.id}`} key={column.id} onDragOver={(event) => { if (canManage) event.preventDefault(); }} onDrop={(event) => {
                event.preventDefault();
                const taskId = Number(event.dataTransfer.getData('application/kaki-project-task-id'));
                if (taskId) void moveTask(taskId, column.id);
              }}>
                <header><div><span>{column.label}</span><b>{tasks.length}</b></div>{canManage && <small>Drop here</small>}</header>
                <div className="kanban-column__items">
                  {tasks.map((task) => <article className={`kanban-task-card ${movingTaskId === task.legacyId ? 'kanban-project-card--moving' : ''}`} draggable={canManage} key={task.id} onDragStart={(event) => event.dataTransfer.setData('application/kaki-project-task-id', String(task.legacyId))} onClick={() => navigate(`/tasks/${task.legacyId}`)} tabIndex={0} role="button" onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/tasks/${task.legacyId}`); }}>
                    <div className="kanban-task-card__top"><StatusPill value={task.fields.priority} /><span>{date(task.fields.due_date)}</span></div>
                    <h3>{displayValue(task.fields.title)}</h3>
                    <p>{displayValue(task.fields.description)}</p>
                    <footer><span>{displayValue(task.relationLabels?.assignee_ids ?? task.relationLabels?.assignee_id ?? task.fields.assignee_ids ?? task.fields.assignee_id)}</span><small>{humanize(column.id)}</small></footer>
                  </article>)}
                  {!tasks.length && <div className="kanban-empty">No tasks</div>}
                </div>
              </section>;
            })}
          </div>
        </article>

        <article className="project-files-card content-card">
          <div className="card-heading"><div><p className="eyebrow">PROJECT FILES</p><h2>Files and deliverables</h2></div><FolderKanban size={19} /></div>
          {canManage && <div className="project-upload-row"><label className="file-picker"><Upload size={16} /><span>{filesToUpload.length ? `${filesToUpload.length} file${filesToUpload.length === 1 ? '' : 's'} selected` : 'Choose files'}</span><input type="file" multiple onChange={(event) => setFilesToUpload(Array.from(event.currentTarget.files ?? []))} /></label><button className="button" onClick={() => void uploadFiles()} disabled={!filesToUpload.length || uploadingFiles}>{uploadingFiles ? 'Uploading…' : 'Upload files'}</button></div>}
          <ul className="project-file-list">
            {workspace.files.map((file) => <li key={file.id}><FileText size={17} /><span><strong>{displayValue(file.fields.original_name ?? file.fields.file_name)}</strong><small>{displayValue(file.relationLabels?.uploaded_by ?? file.fields.uploaded_by)} · {dateTime(file.fields.created_at ?? file.createdAt)}</small></span>{file.url ? <a href={file.url} target="_blank" rel="noreferrer">Open</a> : <em>Legacy file unavailable</em>}</li>)}
            {!workspace.files.length && <li className="project-files-empty">No files are attached to this project yet.</li>}
          </ul>
        </article>
      </div>

      <aside className="project-workspace-side">
        <article className="project-people-card content-card">
          <div className="card-heading"><div><p className="eyebrow">TEAM ASSIGNMENT</p><h2>Ownership</h2></div><UsersRound size={19} /></div>
          {canManage ? <div className="project-settings-form"><label className="field"><span>Assigned team</span><select value={teamId} onChange={(event) => setTeamId(event.target.value)}><option value="">No team assigned</option>{currentOption(teamId, workspace.team ? displayValue(workspace.team.fields.name) : undefined, lookupsQuery.data?.teams)}{lookupsQuery.data?.teams.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label><label className="field"><span>Project head</span><select value={projectHeadId} onChange={(event) => setProjectHeadId(event.target.value)}><option value="">No project head assigned</option>{currentOption(projectHeadId, workspace.projectHead.name ?? undefined, lookupsQuery.data?.users)}{lookupsQuery.data?.users.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label><label className="field"><span>Project status</span><select value={projectStatusValue} onChange={(event) => setProjectStatusValue(event.target.value)}>{['planned', 'active', 'on_hold', 'completed', 'cancelled'].map((status) => <option value={status} key={status}>{humanize(status)}</option>)}</select></label><button className="button button--full" onClick={() => void saveSettings()} disabled={savingSettings || lookupsQuery.isFetching}><Save size={16} /> {savingSettings ? 'Saving…' : 'Save assignment'}</button></div> : <><div className="project-person-row"><span>Project head</span><strong>{workspace.projectHead.name ?? 'Not assigned'}</strong></div><div className="project-person-row"><span>Team</span><strong>{workspace.team ? displayValue(workspace.team.fields.name) : 'Not assigned'}</strong></div></>}
          {lookupsQuery.isError && <p className="form-error">Could not load team or employee names.</p>}
          <div className="project-team-members"><p>TEAM MEMBERS</p>{workspace.teamMembers.map((member) => <div key={member.id}><span>{initials(member.relationLabels?.user_id ?? member.fields.user_id)}</span><strong>{displayValue(member.relationLabels?.user_id ?? member.fields.user_id)}</strong><small>{displayValue(member.fields.role_in_team) === '—' ? 'Team member' : displayValue(member.fields.role_in_team)}</small></div>)}{!workspace.teamMembers.length && <p className="muted-copy">Assign a team to show the team members here.</p>}</div>
        </article>
        <article className="project-accountability-card content-card"><p className="eyebrow">ACCOUNTABILITY</p><dl><div><dt>Department head</dt><dd>{workspace.departmentHead.name ?? 'Not assigned'}</dd></div><div><dt>Project head</dt><dd>{workspace.projectHead.name ?? 'Not assigned'}</dd></div><div><dt>Start date</dt><dd>{date(workspace.data.fields.start_date)}</dd></div><div><dt>Last updated</dt><dd>{dateTime(workspace.data.fields.updated_at ?? workspace.data.updatedAt)}</dd></div></dl></article>
      </aside>
    </section>
    <RecordFormDialog open={taskOpen} resource={projectTaskResource} initialFields={{ status: 'pending', priority: 'normal' }} onClose={() => setTaskOpen(false)} onSubmit={createTask} />
  </>;
}

function currentOption(value: string, label: string | undefined, options: RelationOption[] | undefined) {
  if (!value || options?.some((option) => String(option.id) === value)) return null;
  return <option value={value}>Current · {label ?? `#${value}`}</option>;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function initials(value: unknown): string {
  return String(value ?? 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}

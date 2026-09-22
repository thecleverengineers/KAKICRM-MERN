import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CheckSquare2, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api, type Paginated, type PublicRecord, queryString } from '../lib/api.js';
import { SearchAutocomplete, useDebouncedValue } from './SearchAutocomplete.js';
import { dateTime, displayValue } from '../lib/format.js';

interface RestoreResponse {
  data: {
    restoredTaskIds: number[];
    count: number;
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onRestored: (count: number) => Promise<void>;
}

export function TaskRecycleBinDialog({ open, onClose, onRestored }: Props) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const suggestionSearch = useDebouncedValue(searchInput.trim());
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPage(1);
    setSearch('');
    setSearchInput('');
    setSelectedTaskIds([]);
    setActionError(null);
    setNotice(null);
  }, [open]);

  const query = useQuery({
    queryKey: ['task-recycle-bin', page, search],
    enabled: open,
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks/recycle-bin${queryString({ page, limit: 50, search })}`)
  });
  const suggestionsQuery = useQuery({
    queryKey: ['task-recycle-search-suggestions', suggestionSearch],
    enabled: open && suggestionSearch.length > 0 && suggestionSearch === searchInput.trim(),
    staleTime: 30_000,
    queryFn: () => api<Paginated<PublicRecord>>(`/tasks/recycle-bin${queryString({ page: 1, limit: 6, search: suggestionSearch })}`)
  });

  const visibleTaskIds = (query.data?.data ?? [])
    .map((record) => record.legacyId)
    .filter((legacyId): legacyId is number => typeof legacyId === 'number' && Number.isSafeInteger(legacyId) && legacyId > 0);
  const selectedIdSet = new Set(selectedTaskIds);
  const allVisibleSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((legacyId) => selectedIdSet.has(legacyId));

  useEffect(() => {
    const visibleIds = new Set(visibleTaskIds);
    setSelectedTaskIds((current) => {
      const next = current.filter((legacyId) => visibleIds.has(legacyId));
      return next.length === current.length ? current : next;
    });
  }, [query.data?.data]);

  if (!open) return null;

  const setSelection = (legacyId: number, checked: boolean) => {
    setSelectedTaskIds((current) => checked
      ? current.includes(legacyId) ? current : [...current, legacyId]
      : current.filter((id) => id !== legacyId));
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedTaskIds((current) => checked
      ? [...new Set([...current, ...visibleTaskIds])]
      : current.filter((legacyId) => !visibleTaskIds.includes(legacyId)));
  };

  const restoreSelected = async () => {
    if (!selectedTaskIds.length || restoring) return;
    setRestoring(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<RestoreResponse>('/tasks/recycle-bin/restore', {
        method: 'POST',
        body: JSON.stringify({ taskIds: selectedTaskIds })
      });
      const restoredCount = result.data.count;
      setSelectedTaskIds([]);
      setNotice(`${restoredCount} task${restoredCount === 1 ? '' : 's'} restored to active work.`);
      if ((query.data?.data.length ?? 0) === restoredCount && page > 1) setPage((current) => Math.max(1, current - 1));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task-recycle-bin'] }),
        onRestored(restoredCount)
      ]);
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : 'The selected tasks could not be restored.');
    } finally {
      setRestoring(false);
    }
  };

  const close = () => {
    if (!restoring) onClose();
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={close}>
    <section className="modal task-recycle-modal" role="dialog" aria-modal="true" aria-label="Task recycle bin" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><p className="eyebrow">TASK RECYCLE</p><h2>Restore archived tasks</h2></div><button className="icon-button" type="button" onClick={close} disabled={restoring} aria-label="Close"><X size={18} /></button></div>
      <p className="task-recycle-copy">Recycled tasks keep their original task updates, chat, time logs, files, assignments and project links. Restoring returns them to the active task workflow.</p>
      <div className="task-recycle-toolbar"><SearchAutocomplete
        className="search-autocomplete--recycle"
        value={searchInput}
        onChange={setSearchInput}
        onSubmit={() => { setSearch(searchInput.trim()); setPage(1); setSelectedTaskIds([]); }}
        suggestions={suggestionsQuery.data?.data ?? []}
        getKey={(task) => task.id}
        getLabel={(task) => String(task.fields.title ?? `Task #${task.legacyId ?? ''}`)}
        getDetail={(task) => `${String(task.fields.status ?? 'pending').replaceAll('_', ' ')} · ${String(task.fields.priority ?? 'normal')} priority`}
        onSelect={(task) => { const title = String(task.fields.title ?? ''); setSearchInput(title); setSearch(title); setPage(1); setSelectedTaskIds([]); }}
        loading={searchInput.trim().length > 0 && (suggestionSearch !== searchInput.trim() || suggestionsQuery.isFetching || suggestionsQuery.isPending)}
        error={suggestionsQuery.isError}
        placeholder="Search recycled tasks…"
      /><span>{query.data?.pagination.total ?? 0} in recycle</span></div>
      {notice && <p className="task-recycle-notice" role="status">{notice}</p>}
      {actionError && <p className="form-error">{actionError}</p>}
      {query.isPending && <div className="task-recycle-loading">Loading recycle bin…</div>}
      {query.isError && <div className="task-recycle-loading task-recycle-loading--error">{query.error.message}</div>}
      {!query.isPending && !query.isError && query.data && (query.data.data.length ? <div className="task-recycle-table-wrap"><table className="task-recycle-table"><thead><tr><th className="task-recycle-check"><input className="table-select" type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleVisibleSelection(event.target.checked)} aria-label="Select all visible recycled tasks" /></th><th>Task</th><th>Assignee</th><th>Project</th><th>Recycled</th></tr></thead><tbody>{query.data.data.map((task) => {
        const taskId = task.legacyId;
        const selectable = typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0;
        return <tr key={task.id}><td className="task-recycle-check"><input className="table-select" type="checkbox" disabled={!selectable} checked={typeof taskId === 'number' && selectedIdSet.has(taskId)} onChange={(event) => { if (typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0) setSelection(taskId, event.target.checked); }} aria-label={`Select task ${displayValue(task.fields.title)}`} /></td><td><strong>{displayValue(task.fields.title)}</strong><small>{displayValue(task.fields.status).replaceAll('_', ' ')} · {displayValue(task.fields.priority)} priority</small></td><td>{task.relationLabels?.assignee_ids ?? task.relationLabels?.assignee_id ?? displayValue(task.fields.assignee_ids ?? task.fields.assignee_id)}</td><td>{task.relationLabels?.project_id ?? displayValue(task.fields.project_id)}</td><td>{dateTime(task.archivedAt)}</td></tr>;
      })}</tbody></table></div> : <div className="task-recycle-empty"><CheckSquare2 size={22} /><strong>No recycled tasks</strong><span>Tasks moved to recycle will appear here until you restore them.</span></div>)}
      {query.data && query.data.pagination.pages > 1 && <div className="pagination task-recycle-pagination"><span>Page {query.data.pagination.page} of {query.data.pagination.pages}</span><div><button className="icon-button icon-button--small" type="button" disabled={page <= 1 || restoring} onClick={() => setPage((current) => current - 1)} aria-label="Previous page"><ChevronLeft size={17} /></button><button className="icon-button icon-button--small" type="button" disabled={page >= query.data.pagination.pages || restoring} onClick={() => setPage((current) => current + 1)} aria-label="Next page"><ChevronRight size={17} /></button></div></div>}
      <div className="modal-actions"><button className="button button--secondary" type="button" onClick={close} disabled={restoring}>Close</button><button className="button" type="button" onClick={() => void restoreSelected()} disabled={!selectedTaskIds.length || restoring}><ArchiveRestore size={16} /> {restoring ? 'Restoring…' : `Restore ${selectedTaskIds.length || ''} selected`.trim()}</button></div>
    </section>
  </div>;
}

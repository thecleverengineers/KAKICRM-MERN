import { useMemo, useState, type FormEvent } from 'react';
import { SearchAutocomplete, useDebouncedValue } from '../components/SearchAutocomplete.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Download, Filter, Plus, Printer, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, queryString } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

type CalendarEvent = { id: string; legacyId?: number | null; title: string; type: string; status: string; start: string; end?: string; allDay?: boolean; location?: string; priority?: string; href?: string; raw?: Record<string, unknown> };
type CalendarResponse = { data: CalendarEvent[]; pagination: { page: number; limit: number; total: number; pages: number } };
const types = ['holiday','restricted_holiday','meeting','event','milestone','task','shift','leave','work_from_home','business_travel','payroll','salary','invoice','payment','client_followup','training','onboarding','performance_review','birthday','anniversary','compliance','recruitment','reminder','other'];

export function CalendarPage() {
  const { user, hasPermission } = useAuth(); const navigate = useNavigate(); const qc = useQueryClient();
  const role = String(user?.role ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const canManage = hasPermission('calendar.manage') || ['ceo','chief_executive_officer','chief_executive','admin','hr','hr_manager','human_resources','human_resource'].includes(role);
  const [cursor, setCursor] = useState(() => new Date()); const [view, setView] = useState('month'); const [search, setSearch] = useState(''); const [searchInput, setSearchInput] = useState(''); const suggestionSearch = useDebouncedValue(searchInput.trim()); const [type, setType] = useState(''); const [status, setStatus] = useState(''); const [open, setOpen] = useState(false);
  const range = useMemo(() => { const d = new Date(cursor); const from = new Date(d); const to = new Date(d); if (view === 'day') { to.setDate(to.getDate()+1); } else if (view === 'week' || view === 'timeline') { const day = (d.getDay()+6)%7; from.setDate(d.getDate()-day); to.setTime(from.getTime()); to.setDate(from.getDate()+7); } else if (view === 'year') { from.setMonth(0,1); to.setFullYear(d.getFullYear()+1,0,1); } else { from.setDate(1); to.setMonth(d.getMonth()+1,1); } return { from: from.toISOString(), to: to.toISOString() }; }, [cursor, view]);
  const query = useQuery({ queryKey: ['calendar', range, view, search, type, status], queryFn: () => api<CalendarResponse>(`/calendar${queryString({ ...range, search, type, status, limit: 250 })}`) });
  const suggestionsQuery = useQuery({
    queryKey: ['calendar-search-suggestions', range, suggestionSearch, type, status],
    enabled: suggestionSearch.length > 0 && suggestionSearch === searchInput.trim(),
    staleTime: 30_000,
    queryFn: () => api<CalendarResponse>(`/calendar${queryString({ ...range, search: suggestionSearch, type, status, limit: 6 })}`)
  });
  if (query.isPending) return <LoadingState label="Loading corporate calendar…" />; if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const events = query.data.data; const grouped = events.reduce<Record<string, CalendarEvent[]>>((acc, event) => { const key = event.start.slice(0,10); (acc[key] ??= []).push(event); return acc; }, {});
  const move = (amount: number) => setCursor((d) => { const next = new Date(d); if (view === 'year') next.setFullYear(next.getFullYear()+amount); else if (view === 'week' || view === 'timeline') next.setDate(next.getDate()+amount*7); else next.setMonth(next.getMonth()+amount); return next; });
  const exportCsv = () => { const csv = ['Title,Type,Status,Start,End,Location', ...events.map((e) => [e.title,e.type,e.status,e.start,e.end ?? '',e.location ?? ''].map((v) => `"${String(v).replaceAll('"','""')}"`).join(','))].join('\n'); const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kaki-corporate-calendar.csv'; a.click(); URL.revokeObjectURL(a.href); };
  return <><PageHeader eyebrow="OPERATIONS" title="Corporate Calendar" description="One company calendar for holidays, meetings, work, payroll, leave, milestones and reminders." actions={canManage ? <button className="button" type="button" onClick={() => setOpen(true)}><Plus size={17}/> Add event</button> : undefined} />
    <div className="calendar-toolbar content-card"><button className="icon-button" onClick={() => move(-1)} aria-label="Previous"><ChevronLeft/></button><button className="button button--secondary" onClick={() => setCursor(new Date())}>Today</button><button className="icon-button" onClick={() => move(1)} aria-label="Next"><ChevronRight/></button><strong>{cursor.toLocaleDateString(undefined,{month:'long',year:'numeric'})}</strong><SearchAutocomplete
      className="search-autocomplete--calendar"
      value={searchInput}
      onChange={setSearchInput}
      onSubmit={() => setSearch(searchInput.trim())}
      suggestions={suggestionsQuery.data?.data ?? []}
      getKey={(event) => event.id}
      getLabel={(event) => event.title}
      getDetail={(event) => `${event.type.replaceAll('_', ' ')} · ${new Date(event.start).toLocaleString()}`}
      onSelect={(event) => { if (event.href) navigate(event.href); else { setSearchInput(event.title); setSearch(event.title); } }}
      loading={searchInput.trim().length > 0 && (suggestionSearch !== searchInput.trim() || suggestionsQuery.isFetching || suggestionsQuery.isPending)}
      error={suggestionsQuery.isError}
      placeholder="Search events…"
    /><label className="field"><span>View</span><select value={view} onChange={e=>setView(e.target.value)}>{['day','week','month','year','agenda','timeline'].map(v=><option key={v}>{v}</option>)}</select></label><label className="field"><span>Type</span><select value={type} onChange={e=>setType(e.target.value)}><option value="">All types</option>{types.map(v=><option key={v}>{v.replaceAll('_',' ')}</option>)}</select></label><label className="field"><span>Status</span><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option><option>scheduled</option><option>pending</option><option>completed</option><option>cancelled</option></select></label><button className="icon-button" onClick={exportCsv} aria-label="Export"><Download size={17}/></button><button className="icon-button" onClick={()=>window.print()} aria-label="Print"><Printer size={17}/></button></div>
    <div className={`calendar-board calendar-board--${view}`}>{Object.keys(grouped).sort().map(day=><section className="calendar-day" key={day}><header><CalendarDays size={16}/><strong>{new Date(`${day}T00:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</strong><span>{grouped[day].length}</span></header>{grouped[day].map(event=><article className="calendar-event" key={event.id} tabIndex={0} onClick={()=>event.href && navigate(event.href)} onKeyDown={e=>{if((e.key==='Enter'||e.key===' ')&&event.href) navigate(event.href)}}><div><strong>{event.title}</strong><small>{event.allDay?'All day':new Date(event.start).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}{event.location?` · ${event.location}`:''}</small></div><StatusPill value={event.status || event.type}/></article>)}</section>)}{!events.length&&<div className="content-card calendar-empty"><Filter size={28}/><strong>No calendar entries found</strong><span>Adjust the filters or add a permitted event.</span></div>}</div>
    {open&&<EventDialog onClose={()=>setOpen(false)} onCreated={async()=>{await qc.invalidateQueries({queryKey:['calendar']});setOpen(false)}}/>}</>;
}

function EventDialog({onClose,onCreated}:{onClose:()=>void;onCreated:()=>Promise<void>}) { const [title,setTitle]=useState(''); const [type,setType]=useState('event'); const [start,setStart]=useState(''); const [end,setEnd]=useState(''); const [description,setDescription]=useState(''); const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const submit=async(e:FormEvent)=>{e.preventDefault();setSaving(true);try{await api('/calendar/events',{method:'POST',body:JSON.stringify({title,type,start:new Date(start).toISOString(),end:new Date(end||start).toISOString(),description,visibility:'company'})});await onCreated()}catch(err){setError(err instanceof Error?err.message:'Could not save event.')}finally{setSaving(false)}}; return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={e=>e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">CORPORATE CALENDAR</p><h2>Add event</h2></div><button className="icon-button" onClick={onClose}><X/></button></div><form onSubmit={e=>void submit(e)}><div className="form-grid"><label className="field field--wide"><span>Title *</span><input required value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field"><span>Type</span><select value={type} onChange={e=>setType(e.target.value)}>{types.map(v=><option key={v}>{v}</option>)}</select></label><label className="field"><span>Start *</span><input required type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/></label><label className="field"><span>End *</span><input required type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}/></label><label className="field field--wide"><span>Notes</span><textarea rows={3} value={description} onChange={e=>setDescription(e.target.value)}/></label></div>{error&&<p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button button--secondary" onClick={onClose}>Cancel</button><button className="button" disabled={saving}>{saving?'Saving…':'Save event'}</button></div></form></section></div> }

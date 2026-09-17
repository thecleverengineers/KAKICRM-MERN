import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, LogIn, LogOut, TimerReset } from 'lucide-react';
import { PageHeader } from '../components/PageHeader.js';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { api, type PublicRecord } from '../lib/api.js';
import { dateTime, displayValue } from '../lib/format.js';

interface RemoteWorkData { shifts: PublicRecord[]; checkins: PublicRecord[]; timeLogs: PublicRecord[]; }

export function RemoteWorkPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['remote-work-me'], queryFn: () => api<RemoteWorkData>('/remote-work/me') });
  if (query.isPending) return <LoadingState label="Loading remote-work records…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const activeShift = query.data.shifts.find((shift) => !shift.fields.clock_out_utc);
  const activeTimer = query.data.timeLogs.find((entry) => !entry.fields.end_utc);
  const execute = async (path: string) => { await api(`/remote-work${path}`, { method: 'POST', body: JSON.stringify({}) }); await client.invalidateQueries({ queryKey: ['remote-work-me'] }); };
  return <><PageHeader eyebrow="SELF SERVICE" title="Remote Work" description="Clock remote shifts, capture daily plans and keep a precise timer." /><section className="attendance-hero"><div><span className="attendance-icon"><Clock3 size={25} /></span><div><p>Remote shift</p><h2>{activeShift ? 'In progress' : 'Not started'}</h2><small>{activeShift ? `Since ${dateTime(activeShift.fields.clock_in_ist)}` : 'Start when your remote day begins.'}</small></div></div><div className="attendance-controls"><button className="button button--secondary" onClick={() => void execute(activeTimer ? '/time-logs/stop' : '/time-logs/start')}><TimerReset size={17} /> {activeTimer ? 'Stop timer' : 'Start timer'}</button><button className="button" onClick={() => void execute(activeShift ? '/clock-out' : '/clock-in')}>{activeShift ? <LogOut size={17} /> : <LogIn size={17} />}{activeShift ? 'End shift' : 'Start shift'}</button></div></section><section className="attendance-grid"><article className="content-card"><div className="card-heading"><div><p className="eyebrow">RECENT SHIFTS</p><h2>Remote time</h2></div></div><ul className="simple-list">{query.data.shifts.slice(0, 8).map((shift) => <li key={shift.id}><strong>{dateTime(shift.fields.clock_in_ist)}</strong><span>{shift.fields.clock_out_ist ? `Ended ${dateTime(shift.fields.clock_out_ist)}` : 'In progress'}</span></li>)}</ul></article><article className="content-card"><div className="card-heading"><div><p className="eyebrow">TIMER</p><h2>Time logs</h2></div></div><ul className="simple-list">{query.data.timeLogs.slice(0, 8).map((entry) => <li key={entry.id}><strong>{displayValue(entry.fields.log_type)}</strong><span>{dateTime(entry.fields.start_ist)}</span></li>)}</ul></article></section></>;
}

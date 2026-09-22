import { useEffect, useState } from 'react';
import { useDebouncedValue } from './SearchAutocomplete.js';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, BrainCircuit, CalendarClock, ClipboardCheck, FileText, LayoutDashboard, LockKeyhole, Search, Sparkles, UsersRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, queryString } from '../lib/api.js';
import { isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

interface CommandResult { id: string; kind: string; label: string; detail: string; href: string }
const quickCommands = [
  { label: 'CEO dashboard', detail: 'Business health and executive metrics', href: '/ceo-dashboard', icon: LayoutDashboard },
  { label: 'Executive intelligence', detail: 'CEO capabilities and scenario lab', href: '/ceo/intelligence', icon: BrainCircuit },
  { label: 'AI Insight Centre', detail: 'Forecasts, anomaly detection, risk and AI readiness', href: '/ceo/ai-insights', icon: BrainCircuit },
  { label: 'Approval centre', detail: 'Review pending CEO decisions', href: '/ceo/approvals', icon: ClipboardCheck },
  { label: 'Private workspace', detail: 'Confidential executive notes and planning', href: '/ceo/workspace', icon: LockKeyhole },
  { label: 'Employees', detail: 'Company-wide employee profiles', href: '/data/users', icon: UsersRound },
  { label: 'Meetings', detail: 'Today, upcoming and completed meetings', href: '/data/meetings', icon: CalendarClock },
  { label: 'Financial reports', detail: 'Invoices, expenses, payroll and payments', href: '/data/invoices', icon: BarChart3 },
  { label: 'Audit records', detail: 'CEO decisions and sensitive changes', href: '/data/ceo_audit_logs', icon: FileText },
  { label: 'Ask Clara', detail: 'Activate voice lookup', href: 'clara:activate', icon: Sparkles }
];

export function CeoCommandPalette() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.dashboard');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim());
  const query = useQuery({ queryKey: ['ceo-command-search', debouncedSearch], enabled: allowed && open && debouncedSearch.length >= 1 && debouncedSearch === search.trim(), queryFn: () => api<{ data: CommandResult[] }>(`/ceo/command-search${queryString({ q: debouncedSearch })}`) });
  useEffect(() => {
    if (!allowed) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed]);
  useEffect(() => { if (open) window.setTimeout(() => document.getElementById('ceo-command-input')?.focus(), 0); }, [open]);
  if (!allowed || !open) return null;
  const close = () => { setOpen(false); setSearch(''); };
  const openTarget = (href: string) => {
    close();
    if (href === 'clara:activate') { window.dispatchEvent(new Event('clara:activate')); return; }
    navigate(href);
  };
  const results = query.data?.data ?? [];
  return <div className="ceo-command-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section className="ceo-command-palette" role="dialog" aria-modal="true" aria-label="CEO command palette"><div className="ceo-command-search"><Search size={18} /><input id="ceo-command-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employees, projects, tasks, invoices, clients…" /><kbd>ESC</kbd><button className="icon-button" type="button" onClick={close} aria-label="Close command palette"><X size={17} /></button></div>{search.trim().length < 1 ? <div className="ceo-command-section"><p className="eyebrow">QUICK COMMANDS</p>{quickCommands.map((command) => { const Icon = command.icon; return <button className="ceo-command-item" type="button" key={command.label} onClick={() => openTarget(command.href)}><span className="ceo-command-icon"><Icon size={16} /></span><span><strong>{command.label}</strong><small>{command.detail}</small></span><kbd>↵</kbd></button>; })}</div> : <div className="ceo-command-section"><p className="eyebrow">SEARCH RESULTS</p>{(debouncedSearch !== search.trim() || query.isFetching || query.isPending) && <p className="ceo-command-empty">Finding suggestions in your authorised company records…</p>}{debouncedSearch === search.trim() && query.isError && <p className="ceo-command-empty">Search is temporarily unavailable.</p>}{debouncedSearch === search.trim() && !query.isPending && !query.isFetching && !query.isError && !results.length && <p className="ceo-command-empty">No matching employee, project, task, invoice, client or department.</p>}{debouncedSearch === search.trim() && !query.isFetching && results.map((result) => <button className="ceo-command-item" type="button" key={result.id} onClick={() => openTarget(result.href)}><span className="ceo-command-icon"><FileText size={16} /></span><span><strong>{result.label}</strong><small>{result.kind}{result.detail ? ` · ${result.detail}` : ''}</small></span><kbd>↵</kbd></button>)}</div>}<footer><span>CEO command palette</span><span><kbd>Ctrl</kbd> + <kbd>K</kbd> to open</span></footer></section></div>;
}

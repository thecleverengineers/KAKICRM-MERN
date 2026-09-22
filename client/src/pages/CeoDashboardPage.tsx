import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BarChart3, BriefcaseBusiness, CalendarClock, CheckCircle2, ClipboardCheck, Crown, FileDown, IndianRupee, KeyRound, UsersRound } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusPill } from '../components/StatusPill.js';
import { api, apiUrl, getAccessToken, type PublicRecord, queryString } from '../lib/api.js';
import { ceoDate, formatCeoCurrency, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

interface CeoCard { id: string; label: string; value: string | number; href: string; tone: string; detail: string }
interface CeoSummary {
  generatedAt: string;
  period: { today: string; month: string; year: string; from: string | null; to: string | null };
  cards: CeoCard[];
  financial: { revenue: number; invoiced: number; collected: number; expenses: number; profit: number; receivables: number; cashFlow: number; paidInvoices: number; partialInvoices: number; unpaidInvoices: number; overdueInvoices: number; monthlyGrowth: number; yearlyRevenue: number; monthlyRevenue: number; previousMonthRevenue: number };
  projects: { total: number; active: number; completed: number; delayed: number; highRisk: number; portfolio: Array<{ id: number | null; name: string; status: string; delayed: boolean; highRisk: boolean; href: string }> };
  workforce: { activeEmployees: number; attendanceToday: number; attendanceRate: number; overtimeMinutes: number; openTasks: number; delayedTasks: number; payrollTotal: number };
  departmentPerformance: Array<{ id: number | null; name: string; head: string | null; employees: number; activeProjects: number; pendingTasks: number; delayedTasks: number; attendanceRate: number; overtimeMinutes: number; performanceScore: number; href: string }>;
  crm: { clients: number; leads: number; quotations: number; invoices: number; payments: number };
  approvals: { pending: number; recent: PublicRecord[] };
  agenda: { tasks: Array<{ id: number | null; title: string; href: string }>; meetings: Array<{ id: number | null; title: string; href: string }>; deadlines: number };
  recentCriticalActivities: Array<{ id: number | null; title: string; detail: string; at: string }>;
  businessHealth: { score: number; label: string };
  executiveSummary: string;
  sources: string[];
}

export function CeoDashboardPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.dashboard');
  const [company, setCompany] = useState('');
  const [billingProfileId, setBillingProfileId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters = { company, billingProfileId, departmentId, projectId, clientId, from, to };
  const query = useQuery({
    queryKey: ['ceo-summary', filters],
    enabled: allowed,
    queryFn: () => api<CeoSummary>(`/ceo/summary${queryString(filters)}`)
  });

  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Preparing the executive command dashboard…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const summary = query.data;
  return <>
    <PageHeader eyebrow="EXECUTIVE COMMAND · KAKIVI CHISHI" title="CEO Command Dashboard" description="A company-wide view of financial health, delivery risk, workforce capacity and decisions awaiting you." actions={<div className="ceo-header-actions"><button className="button button--secondary" onClick={() => navigate('/credential-vault')}><KeyRound size={16} /> Credential Vault</button><button className="button button--secondary" onClick={() => navigate('/ceo/approvals')}><ClipboardCheck size={16} /> Approval centre{summary.approvals.pending ? ` (${summary.approvals.pending})` : ''}</button><button className="button" onClick={() => navigate('/ceo/workspace')}><Crown size={16} /> Private workspace</button></div>} />
    <section className="ceo-filter-card content-card">
      <div className="card-heading"><div><p className="eyebrow">EXECUTIVE FILTERS</p><h2>Focus the company view</h2></div><span className="ceo-data-stamp">Facts through {ceoDate(summary.generatedAt)}</span></div>
      <div className="ceo-filter-grid">
        <label className="field"><span>Company</span><input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Any company" /></label>
        <label className="field"><span>Billing profile ID</span><input value={billingProfileId} onChange={(event) => setBillingProfileId(event.target.value)} inputMode="numeric" placeholder="All profiles" /></label>
        <label className="field"><span>Department ID</span><input value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} inputMode="numeric" placeholder="All departments" /></label>
        <label className="field"><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} inputMode="numeric" placeholder="All projects" /></label>
        <label className="field"><span>Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} inputMode="numeric" placeholder="All clients" /></label>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="text-button ceo-filter-reset" type="button" onClick={() => { setCompany(''); setBillingProfileId(''); setDepartmentId(''); setProjectId(''); setClientId(''); setFrom(''); setTo(''); }}>Clear filters</button>
      </div>
    </section>
    <section className="ceo-health-strip">
      <div className="ceo-health-score"><span className="ceo-health-ring"><strong>{summary.businessHealth.score}</strong><small>/100</small></span><div><p className="eyebrow">BUSINESS HEALTH</p><h2>{summary.businessHealth.label}</h2><span>Portfolio, receivables, approvals and attendance combined</span></div></div>
      <div className="ceo-summary-copy"><p className="eyebrow">DAILY EXECUTIVE SUMMARY</p><p>{summary.executiveSummary}</p><small>CRM facts for {summary.period.today}; predictions remain recommendations.</small></div>
    </section>
    <section className="ceo-card-grid" aria-label="Executive metrics">
      {summary.cards.map((item) => <button key={item.id} type="button" className={`ceo-metric-card ceo-metric-card--${item.tone}`} onClick={() => navigate(item.href)}><span className="ceo-metric-card__top"><span>{item.label}</span><ArrowRight size={15} /></span><strong>{item.value}</strong><small>{item.detail}</small></button>)}
    </section>
    <section className="ceo-content-grid">
      <article className="content-card ceo-panel ceo-panel--financial"><div className="card-heading"><div><p className="eyebrow">STRATEGIC FINANCE</p><h2>Revenue, cost and cash flow</h2></div><BarChart3 size={19} /></div><div className="ceo-financial-grid"><MetricLine label="Revenue" value={formatCeoCurrency(summary.financial.revenue)} tone="positive" /><MetricLine label="Expenses" value={formatCeoCurrency(summary.financial.expenses)} tone="negative" /><MetricLine label="Profit" value={formatCeoCurrency(summary.financial.profit)} tone={summary.financial.profit >= 0 ? 'positive' : 'negative'} /><MetricLine label="Receivables" value={formatCeoCurrency(summary.financial.receivables)} tone="warning" /><MetricLine label="Cash flow" value={formatCeoCurrency(summary.financial.cashFlow)} tone="positive" /><MetricLine label="Month growth" value={`${summary.financial.monthlyGrowth >= 0 ? '+' : ''}${summary.financial.monthlyGrowth}%`} tone={summary.financial.monthlyGrowth >= 0 ? 'positive' : 'negative'} /></div><div className="ceo-financial-foot"><span>Paid {summary.financial.paidInvoices}</span><span>Partial {summary.financial.partialInvoices}</span><span>Unpaid {summary.financial.unpaidInvoices}</span><span>Overdue {summary.financial.overdueInvoices}</span></div></article>
      <article className="content-card ceo-panel"><div className="card-heading"><div><p className="eyebrow">PORTFOLIO WATCH</p><h2>Projects needing attention</h2></div><button className="text-button" onClick={() => navigate('/projects')}>Open portfolio <ArrowRight size={15} /></button></div><div className="ceo-project-list">{summary.projects.portfolio.filter((project) => project.delayed || project.highRisk).slice(0, 6).map((project) => <button type="button" key={project.id ?? project.name} className="ceo-project-row" onClick={() => navigate(project.href)}><span className="ceo-project-icon"><BriefcaseBusiness size={16} /></span><span><strong>{project.name}</strong><small>{project.delayed ? 'Delayed' : 'Risk watch'} · {project.status.replaceAll('_', ' ')}</small></span>{project.highRisk && <StatusPill value="high risk" />}</button>)}{!summary.projects.portfolio.some((project) => project.delayed || project.highRisk) && <p className="muted-copy">No delayed or high-risk projects in this view.</p>}</div></article>
      <article className="content-card ceo-panel ceo-panel--departments"><div className="card-heading"><div><p className="eyebrow">DEPARTMENT PERFORMANCE</p><h2>Workload and delivery by team</h2></div><button className="text-button" onClick={() => navigate('/data/departments')}>All departments <ArrowRight size={15} /></button></div><div className="ceo-department-table"><div className="ceo-table-head"><span>Department</span><span>People</span><span>Open tasks</span><span>Attendance</span><span>Score</span></div>{summary.departmentPerformance.slice(0, 10).map((department) => <button type="button" key={department.id ?? department.name} className="ceo-table-row" onClick={() => navigate(department.href)}><span><strong>{department.name}</strong><small>{department.head ? `Head: ${department.head}` : 'No head assigned'}</small></span><b>{department.employees}</b><b>{department.pendingTasks}{department.delayedTasks ? ` (${department.delayedTasks} late)` : ''}</b><b>{Math.round(department.attendanceRate)}%</b><b className={department.performanceScore < 60 ? 'ceo-score--low' : ''}>{department.performanceScore}</b></button>)}{!summary.departmentPerformance.length && <p className="muted-copy">No departments found for these filters.</p>}</div></article>
      <article className="content-card ceo-panel"><div className="card-heading"><div><p className="eyebrow">WORKFORCE INTELLIGENCE</p><h2>People, time and payroll</h2></div><UsersRound size={19} /></div><div className="ceo-workforce-stats"><MetricLine label="Active employees" value={summary.workforce.activeEmployees} /><MetricLine label="Attendance today" value={`${Math.round(summary.workforce.attendanceRate)}%`} /><MetricLine label="Overtime" value={`${summary.workforce.overtimeMinutes} min`} /><MetricLine label="Open tasks" value={summary.workforce.openTasks} /><MetricLine label="Delayed tasks" value={summary.workforce.delayedTasks} /><MetricLine label="Payroll total" value={formatCeoCurrency(summary.workforce.payrollTotal)} /></div><button className="text-button" onClick={() => navigate('/workforce')}>Open workforce <ArrowRight size={15} /></button></article>
      <article className="content-card ceo-panel"><div className="card-heading"><div><p className="eyebrow">APPROVAL CENTRE</p><h2>Decisions waiting for you</h2></div><button className="text-button" onClick={() => navigate('/ceo/approvals')}>View all <ArrowRight size={15} /></button></div><div className="ceo-approval-list">{summary.approvals.recent.slice(0, 5).map((approval) => <button type="button" key={approval.id} className="ceo-approval-row" onClick={() => navigate('/ceo/approvals')}><span className="ceo-approval-icon"><ClipboardCheck size={16} /></span><span><strong>{String(approval.fields.title ?? 'Approval request')}</strong><small>{String(approval.fields.type ?? 'Executive request')} · {approval.fields.amount ? formatCeoCurrency(approval.fields.amount) : 'No amount provided'}</small></span><ArrowRight size={15} /></button>)}{!summary.approvals.recent.length && <p className="muted-copy">No pending CEO approvals.</p>}</div></article>
      <article className="content-card ceo-panel"><div className="card-heading"><div><p className="eyebrow">TODAY</p><h2>Meetings, tasks and deadlines</h2></div><CalendarClock size={19} /></div><div className="ceo-agenda-list">{summary.agenda.meetings.map((meeting) => <button type="button" key={`meeting-${meeting.id}`} onClick={() => navigate(meeting.href)}><CalendarClock size={15} /><span>{meeting.title}</span><small>Meeting</small></button>)}{summary.agenda.tasks.map((task) => <button type="button" key={`task-${task.id}`} onClick={() => navigate(task.href)}><CheckCircle2 size={15} /><span>{task.title}</span><small>Deadline</small></button>)}{!summary.agenda.deadlines && <p className="muted-copy">Nothing due today.</p>}</div></article>
    </section>
    <section className="ceo-quick-links"><button onClick={() => navigate('/data/clients')}><UsersRound size={17} /> Clients & CRM <ArrowRight size={15} /></button><button onClick={() => navigate('/payroll')}><IndianRupee size={17} /> Payroll oversight <ArrowRight size={15} /></button><button onClick={() => navigate('/data/expenses')}><BarChart3 size={17} /> Expenses & budgets <ArrowRight size={15} /></button><button onClick={() => navigate('/ceo/settings')}><Crown size={17} /> Approval rules <ArrowRight size={15} /></button><button onClick={() => void downloadCeoCsv()}><FileDown size={17} /> Download CSV report <ArrowRight size={15} /></button></section>
    <p className="ceo-source-note">Data sources: {summary.sources.join(', ')}. Sensitive records remain available only through the CEO-authorized workspace and audited actions.</p>
  </>;
}

async function downloadCeoCsv(): Promise<void> {
  const token = getAccessToken();
  const response = await fetch(apiUrl('/ceo/reports/summary?format=csv'), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ceo-executive-summary.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricLine({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <div className={`ceo-metric-line${tone ? ` ceo-metric-line--${tone}` : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

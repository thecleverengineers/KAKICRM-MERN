import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardCheck,
  Gauge,
  IndianRupee,
  Radar,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  TrendingUp,
  UsersRound,
  X,
  type LucideIcon
} from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, apiUrl, getAccessToken, queryString } from '../lib/api.js';
import { ceoDate, formatCeoCurrency, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

type FeatureCategory = 'Finance' | 'Growth' | 'Delivery' | 'People' | 'Governance' | 'Strategy';
type FeatureAction = 'scenario' | 'decision' | 'clara' | 'export';

interface IntelligenceSummary {
  generatedAt: string;
  period: { today: string; from: string | null; to: string | null };
  financial: { revenue: number; invoiced: number; collected: number; expenses: number; profit: number; receivables: number; cashFlow: number; paidInvoices: number; partialInvoices: number; unpaidInvoices: number; overdueInvoices: number; monthlyGrowth: number; yearlyRevenue: number; monthlyRevenue: number };
  projects: { total: number; active: number; completed: number; delayed: number; highRisk: number };
  workforce: { activeEmployees: number; attendanceToday: number; attendanceRate: number; overtimeMinutes: number; openTasks: number; delayedTasks: number; payrollTotal: number };
  departmentPerformance: Array<{ pendingTasks: number; delayedTasks: number; performanceScore: number }>;
  crm: { clients: number; leads: number; quotations: number; invoices: number; payments: number };
  approvals: { pending: number };
  agenda: { deadlines: number };
  recentCriticalActivities: Array<{ id: number | null; title: string; detail: string; at: string }>;
  businessHealth: { score: number; label: string };
  executiveSummary: string;
  sources: string[];
}

interface ExecutiveFeature {
  id: string;
  category: FeatureCategory;
  title: string;
  detail: string;
  value: (summary: IntelligenceSummary) => string;
  href?: string;
  action?: FeatureAction;
}

interface DecisionDraft {
  title: string;
  description: string;
  amount: string;
}

const categoryIcons: Record<FeatureCategory, LucideIcon> = {
  Finance: IndianRupee,
  Growth: TrendingUp,
  Delivery: BriefcaseBusiness,
  People: UsersRound,
  Governance: ShieldCheck,
  Strategy: BrainCircuit
};

const categoryDescriptions: Record<FeatureCategory, string> = {
  Finance: 'Cash, margin, receivables and financial control.',
  Growth: 'Pipeline, clients, conversion and commercial momentum.',
  Delivery: 'Portfolio execution, workload and delivery risk.',
  People: 'Capacity, attendance, payroll and workforce signals.',
  Governance: 'Approvals, authority, auditability and operating discipline.',
  Strategy: 'Scenarios, decision velocity, intelligence and planning.'
};

const categoryOrder: FeatureCategory[] = ['Finance', 'Growth', 'Delivery', 'People', 'Governance', 'Strategy'];

const feature = (
  id: string,
  category: FeatureCategory,
  title: string,
  detail: string,
  value: (summary: IntelligenceSummary) => string,
  href?: string,
  action?: FeatureAction
): ExecutiveFeature => ({ id, category, title, detail, value, href, action });

const countLabel = (value: number, singular: string, plural = `${singular}s`): string => `${value} ${value === 1 ? singular : plural}`;
const percent = (value: number, denominator: number): string => denominator > 0 ? `${Math.round((value / denominator) * 100)}%` : '—';
const signedPercent = (value: number): string => `${value >= 0 ? '+' : ''}${Math.round(value)}%`;
const average = (value: number, denominator: number, suffix = ''): string => denominator > 0 ? `${Math.round(value / denominator)}${suffix}` : '—';

const features: ExecutiveFeature[] = [
  feature('F01', 'Finance', 'Revenue run-rate', 'Annualise the current monthly revenue signal to see the operating pace.', (s) => formatCeoCurrency(s.financial.monthlyRevenue * 12), '/invoices'),
  feature('F02', 'Finance', 'Invoiced value', 'Track the commercial value converted into issued invoices for the selected view.', (s) => formatCeoCurrency(s.financial.invoiced), '/invoices'),
  feature('F03', 'Finance', 'Collected cash', 'See payments actually recorded, separate from invoiced promises.', (s) => formatCeoCurrency(s.financial.collected), '/data/payments'),
  feature('F04', 'Finance', 'Receivables exposure', 'Quantify open customer balances requiring collection attention.', (s) => formatCeoCurrency(s.financial.receivables), '/invoices'),
  feature('F05', 'Finance', 'Overdue collection queue', 'Open the invoices that have crossed their expected payment date.', (s) => countLabel(s.financial.overdueInvoices, 'overdue invoice'), '/invoices'),
  feature('F06', 'Finance', 'Profit bridge', 'Read recorded revenue less recorded expenses as the current operating result.', (s) => formatCeoCurrency(s.financial.profit), '/data/invoices'),
  feature('F07', 'Finance', 'Cash-flow position', 'Compare recorded collections and expenses to understand cash movement.', (s) => formatCeoCurrency(s.financial.cashFlow), '/data/payments'),
  feature('F08', 'Finance', 'Month-over-month growth', 'Spot momentum changes against the previous month revenue signal.', (s) => signedPercent(s.financial.monthlyGrowth), '/ceo-dashboard'),
  feature('F09', 'Finance', 'Annual revenue view', 'Review the year-to-date revenue signal available in the CRM.', (s) => formatCeoCurrency(s.financial.yearlyRevenue), '/ceo-dashboard'),
  feature('F10', 'Finance', 'Paid invoice ratio', 'Measure how much of the invoice population is fully settled.', (s) => percent(s.financial.paidInvoices, s.financial.paidInvoices + s.financial.partialInvoices + s.financial.unpaidInvoices), '/invoices'),
  feature('F11', 'Finance', 'Collection efficiency', 'Compare cash collected with invoice value to surface conversion leakage.', (s) => percent(s.financial.collected, s.financial.invoiced), '/data/payments'),
  feature('F12', 'Finance', 'Expense burn', 'Keep a live view of recorded operating costs consuming the period.', (s) => formatCeoCurrency(s.financial.expenses), '/data/expenses'),
  feature('F13', 'Finance', 'Expense-to-revenue ratio', 'Watch cost intensity as a proportion of recorded revenue.', (s) => percent(s.financial.expenses, s.financial.revenue), '/data/expenses'),
  feature('F14', 'Finance', 'Payroll burden', 'See payroll exposure relative to revenue before making growth decisions.', (s) => percent(s.workforce.payrollTotal, s.financial.revenue), '/payroll'),
  feature('F15', 'Finance', 'Finance exception queue', 'Combine overdue invoices and approvals into one executive attention signal.', (s) => countLabel(s.financial.overdueInvoices + s.approvals.pending, 'finance flag'), '/ceo/approvals'),

  feature('G01', 'Growth', 'Client base health', 'Open the company-wide client population and account details.', (s) => countLabel(s.crm.clients, 'client'), '/data/clients'),
  feature('G02', 'Growth', 'Lead pipeline', 'Monitor the number of leads currently visible to the executive view.', (s) => countLabel(s.crm.leads, 'lead'), '/data/leads'),
  feature('G03', 'Growth', 'Quotation volume', 'Review commercial proposals awaiting progression or conversion.', (s) => countLabel(s.crm.quotations, 'quotation'), '/data/quotations'),
  feature('G04', 'Growth', 'Quote-to-invoice funnel', 'Compare quotation volume with invoice volume as a fast funnel health check.', (s) => `${s.crm.quotations} → ${s.crm.invoices}`, '/data/quotations'),
  feature('G05', 'Growth', 'Client concentration review', 'Use the client ledger to inspect dependency on a small number of accounts.', () => 'Review mix', '/data/clients'),
  feature('G06', 'Growth', 'Client follow-up queue', 'Jump into the CRM command view to find account actions and next steps.', () => 'Open CRM', '/data/clients'),
  feature('G07', 'Growth', 'Account risk watch', 'Use receivables and client records together to identify commercial exposure.', (s) => formatCeoCurrency(s.financial.receivables), '/data/clients'),
  feature('G08', 'Growth', 'Renewal and maintenance watch', 'Review maintenance contracts and recurring account obligations.', () => 'Review contracts', '/data/maintenance_contracts'),
  feature('G09', 'Growth', 'Payment behaviour', 'Inspect recorded payment events for account-level collection patterns.', (s) => countLabel(s.crm.payments, 'payment event'), '/data/payments'),
  feature('G10', 'Growth', 'CRM coverage', 'See the total commercial records feeding the executive growth view.', (s) => countLabel(s.crm.clients + s.crm.leads + s.crm.quotations, 'CRM record'), '/data/clients'),
  feature('G11', 'Growth', 'Sales command search', 'Use the CEO command palette to search clients, leads, quotes and invoices in one place.', () => 'Ctrl + K', undefined, 'clara'),
  feature('G12', 'Growth', 'Commercial decision queue', 'Capture a pricing, discount or account-growth decision for an auditable review.', (s) => countLabel(s.approvals.pending, 'pending decision'), '/ceo/approvals', 'decision'),

  feature('D01', 'Delivery', 'Active portfolio', 'See the current count of active projects across departments.', (s) => countLabel(s.projects.active, 'active project'), '/projects'),
  feature('D02', 'Delivery', 'Portfolio completion rate', 'Measure completed projects against the total project population.', (s) => percent(s.projects.completed, s.projects.total), '/projects'),
  feature('D03', 'Delivery', 'Delayed projects', 'Open delivery work that has passed its expected date.', (s) => countLabel(s.projects.delayed, 'delayed project'), '/projects'),
  feature('D04', 'Delivery', 'High-risk projects', 'Keep the risk watch visible while reviewing the portfolio.', (s) => countLabel(s.projects.highRisk, 'high-risk project'), '/projects'),
  feature('D05', 'Delivery', 'Deadline heat', 'Count the tasks and meetings competing for attention today.', (s) => countLabel(s.agenda.deadlines, 'today deadline'), '/calendar'),
  feature('D06', 'Delivery', 'Open task backlog', 'Track unfinished work across the company in one executive signal.', (s) => countLabel(s.workforce.openTasks, 'open task'), '/tasks'),
  feature('D07', 'Delivery', 'Overdue task pressure', 'Measure late tasks that may become client or margin risk.', (s) => countLabel(s.workforce.delayedTasks, 'late task'), '/tasks'),
  feature('D08', 'Delivery', 'Department scorecard', 'Compare delivery, attendance and workload scores by department.', (s) => countLabel(s.departmentPerformance.length, 'department'), '/data/departments'),
  feature('D09', 'Delivery', 'Workload balance', 'Find the highest open-task load among departments before reallocating work.', (s) => average(Math.max(...s.departmentPerformance.map((d) => d.pendingTasks), 0), 1, ' open'), '/data/departments'),
  feature('D10', 'Delivery', 'Project budget variance', 'Open portfolio records to investigate scope, budget and execution variance.', () => 'Open portfolio', '/projects'),
  feature('D11', 'Delivery', 'Blocked work queue', 'Use late-task pressure as the starting point for an escalation review.', (s) => countLabel(s.workforce.delayedTasks, 'blocked signal'), '/tasks'),
  feature('D12', 'Delivery', 'Delivery escalation queue', 'Combine project and task risk so nothing critical hides in a single module.', (s) => countLabel(s.projects.delayed + s.projects.highRisk + s.workforce.delayedTasks, 'delivery flag'), '/projects'),
  feature('D13', 'Delivery', 'Project and client drilldown', 'Move from the portfolio to linked projects, clients and delivery details.', () => 'Cross-linked', '/projects'),
  feature('D14', 'Delivery', 'Task assignment command', 'Open the task workspace to rebalance ownership and deadlines.', () => 'Open tasks', '/tasks'),

  feature('P01', 'People', 'Active workforce', 'Track the employee population currently marked active.', (s) => countLabel(s.workforce.activeEmployees, 'active employee'), '/data/users'),
  feature('P02', 'People', 'Attendance today', 'Monitor the attendance rate used in the company health score.', (s) => `${Math.round(s.workforce.attendanceRate)}%`, '/attendance'),
  feature('P03', 'People', 'Overtime exposure', 'See recorded overtime minutes that may affect cost and wellbeing.', (s) => `${Math.round(s.workforce.overtimeMinutes)} min`, '/workforce'),
  feature('P04', 'People', 'Payroll exposure', 'Review payroll total before approving budgets or hiring plans.', (s) => formatCeoCurrency(s.workforce.payrollTotal), '/payroll'),
  feature('P05', 'People', 'Workforce capacity', 'Approximate open-task load per active employee for a fast capacity check.', (s) => average(s.workforce.openTasks, s.workforce.activeEmployees, ' tasks/person'), '/workforce'),
  feature('P06', 'People', 'Overtime per person', 'Surface average overtime minutes per active employee.', (s) => average(s.workforce.overtimeMinutes, s.workforce.activeEmployees, ' min/person'), '/workforce'),
  feature('P07', 'People', 'Payroll per employee', 'View the average payroll exposure per active employee.', (s) => formatCeoCurrency(s.workforce.activeEmployees > 0 ? s.workforce.payrollTotal / s.workforce.activeEmployees : 0), '/payroll'),
  feature('P08', 'People', 'Leave coverage review', 'Open leave records before approving schedules or delivery commitments.', () => 'Review coverage', '/leave'),
  feature('P09', 'People', 'Hiring pipeline', 'Inspect recruitment applicants and open positions against growth plans.', () => 'Review hiring', '/data/recruitment_applicants'),
  feature('P10', 'People', 'Roles and skills gap', 'Use employee profiles and departments to identify missing ownership.', () => 'Review roles', '/data/users'),
  feature('P11', 'People', 'Employee performance', 'Compare department scores and drill into accountable teams.', (s) => s.departmentPerformance.length ? `${Math.round(s.departmentPerformance.reduce((total, d) => total + d.performanceScore, 0) / s.departmentPerformance.length)}/100 avg` : '—', '/data/departments'),
  feature('P12', 'People', 'Workforce alerts', 'Raise attention when attendance or overtime signals need leadership review.', (s) => s.workforce.attendanceRate < 80 || s.workforce.overtimeMinutes > s.workforce.activeEmployees * 240 ? 'Needs review' : 'Stable', '/workforce'),
  feature('P13', 'People', 'Remote-work oversight', 'Open remote-work records and keep distributed delivery visible.', () => 'Open remote work', '/remote-work'),

  feature('V01', 'Governance', 'Approval queue', 'See requests that require CEO action and keep decision latency low.', (s) => countLabel(s.approvals.pending, 'pending approval'), '/ceo/approvals'),
  feature('V02', 'Governance', 'Approval ageing', 'Open the queue to review the oldest unresolved decisions and their context.', (s) => countLabel(s.approvals.pending, 'item to age'), '/ceo/approvals'),
  feature('V03', 'Governance', 'Delegation and acting authority', 'Manage time-bounded executive authority with explicit limits.', () => 'Control access', '/data/ceo_delegations'),
  feature('V04', 'Governance', 'Decision log', 'Review approved, rejected, returned and delegated executive decisions.', () => 'Audited history', '/ceo/approvals'),
  feature('V05', 'Governance', 'CEO audit trail', 'Inspect sensitive changes with actor, timestamp and reason evidence.', () => 'Open audit', '/ceo/audit'),
  feature('V06', 'Governance', 'Risk register', 'Maintain financial, project, client, people and security risks.', () => 'Open register', '/data/ceo_risks'),
  feature('V07', 'Governance', 'Goals and OKR control', 'Connect company goals with owners, progress and due dates.', () => 'Track goals', '/data/ceo_goals'),
  feature('V08', 'Governance', 'Executive notes', 'Keep confidential CEO planning separate from operational records.', () => 'Private notes', '/ceo/workspace'),
  feature('V09', 'Governance', 'Company announcements', 'Draft, target, publish and expire executive communications.', () => 'Broadcast control', '/data/ceo_announcements'),
  feature('V10', 'Governance', 'Google integration posture', 'Review the configured OAuth and meeting integration status.', () => 'Open settings', '/ceo/settings'),
  feature('V11', 'Governance', 'Data quality review', 'Use source coverage and timestamps to judge the freshness of the snapshot.', (s) => countLabel(s.sources.length, 'source'), '/ceo-dashboard'),
  feature('V12', 'Governance', 'Sensitive-action guardrail', 'Capture a proposed action as a permission-checked, auditable approval request.', () => 'Raise request', undefined, 'decision'),

  feature('S01', 'Strategy', 'Business health score', 'A transparent 0–100 signal combining portfolio, receivables, approvals and attendance.', (s) => `${s.businessHealth.score}/100`, '/ceo-dashboard'),
  feature('S02', 'Strategy', 'Daily executive brief', 'Read the generated snapshot summary with its period and data sources.', () => 'Read brief', '/ceo-dashboard'),
  feature('S03', 'Strategy', 'Board-pack export', 'Download a flat executive summary for board, finance or leadership review.', () => 'CSV export', undefined, 'export'),
  feature('S04', 'Strategy', 'Scenario planner', 'Model revenue, cost and collection assumptions before taking action.', () => 'Open lab', undefined, 'scenario'),
  feature('S05', 'Strategy', 'What-if revenue', 'Test an upside or downside revenue movement against recorded performance.', () => 'Model revenue', undefined, 'scenario'),
  feature('S06', 'Strategy', 'What-if cost', 'Test operating-cost reduction assumptions and their profit effect.', () => 'Model costs', undefined, 'scenario'),
  feature('S07', 'Strategy', 'What-if collection', 'Test how faster collections could improve cash position.', () => 'Model cash', undefined, 'scenario'),
  feature('S08', 'Strategy', 'Executive action centre', 'Turn an insight into a pending decision with context and an audit trail.', () => 'Raise decision', undefined, 'decision'),
  feature('S09', 'Strategy', 'Command palette', 'Search authorised records and jump directly to the next operating surface.', () => 'Ctrl + K', undefined, 'clara'),
  feature('S10', 'Strategy', 'Clara assistant', 'Activate the workspace assistant for a voice-first lookup of authorised records.', () => 'Ask Clara', undefined, 'clara'),
  feature('S11', 'Strategy', 'Report export', 'Use the executive report endpoint for repeatable downstream analysis.', () => 'Download CSV', undefined, 'export'),
  feature('S12', 'Strategy', 'Saved focus dimensions', 'Re-run the command view by period, company, department, project or client.', () => '7 filters', '/ceo-dashboard'),
  feature('S13', 'Strategy', 'Evidence-linked decisions', 'Keep facts, assumptions and the resulting approval request connected.', () => 'Evidence first', undefined, 'decision'),
  feature('S14', 'Strategy', 'Critical signal radar', 'Surface recent activity containing risk, urgency, failure or overdue language.', (s) => countLabel(s.recentCriticalActivities.length, 'critical signal'), '/ceo/audit'),
  feature('S15', 'Strategy', 'Scenario forecast register', 'Save best, expected and worst-case assumptions in the executive workspace.', () => 'Open forecasts', '/data/ceo_forecasts'),
  feature('S16', 'Strategy', 'CEO operating cadence', 'Move from morning brief to approvals, portfolio review, workforce review and audit.', () => '5 checkpoints', '/ceo-dashboard'),
  feature('S17', 'Strategy', 'AI insight centre', 'Open live forecasts, anomaly detection, risk classification and deep-learning readiness controls.', () => 'Open models', '/ceo/ai-insights')
];

export function CeoIntelligencePage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.dashboard');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FeatureCategory | 'All'>('All');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [revenueUplift, setRevenueUplift] = useState('10');
  const [costReduction, setCostReduction] = useState('5');
  const [collectionLift, setCollectionLift] = useState('8');
  const [decision, setDecision] = useState<DecisionDraft | null>(null);
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  const [message, setMessage] = useState('');
  const filters = { from, to };
  const query = useQuery({
    queryKey: ['ceo-intelligence', filters],
    enabled: allowed,
    queryFn: () => api<IntelligenceSummary>(`/ceo/summary${queryString(filters)}`)
  });

  const visibleFeatures = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return features.filter((item) => {
      const matchesCategory = category === 'All' || item.category === category;
      const haystack = `${item.id} ${item.category} ${item.title} ${item.detail}`.toLowerCase();
      return matchesCategory && (!needle || haystack.includes(needle));
    });
  }, [category, search]);

  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Assembling the CEO intelligence workspace…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const summary = query.data;
  const revenueFactor = 1 + clampPercent(revenueUplift) / 100;
  const costFactor = 1 - clampPercent(costReduction) / 100;
  const scenarioRevenue = summary.financial.revenue * revenueFactor;
  const scenarioExpenses = summary.financial.expenses * costFactor;
  const scenarioCollections = summary.financial.collected + (summary.financial.receivables * clampPercent(collectionLift)) / 100;
  const scenarioProfit = scenarioRevenue - scenarioExpenses;
  const scenarioCash = summary.financial.cashFlow + scenarioCollections - summary.financial.collected;

  const openFeature = (item: ExecutiveFeature) => {
    setMessage('');
    if (item.action === 'scenario') {
      window.setTimeout(() => document.getElementById('ceo-scenario-lab')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return;
    }
    if (item.action === 'decision') {
      setDecision({ title: item.title, description: `${item.detail} Snapshot generated ${ceoDate(summary.generatedAt)}.`, amount: '' });
      setDecisionError('');
      return;
    }
    if (item.action === 'clara') {
      window.dispatchEvent(new Event('clara:activate'));
      setMessage('Clara activation sent to the workspace assistant.');
      return;
    }
    if (item.action === 'export') {
      void downloadCeoCsv();
      setMessage('Executive CSV export requested.');
      return;
    }
    if (item.href) navigate(item.href);
  };

  const raiseScenarioDecision = () => {
    setDecision({
      title: 'Review scenario assumptions',
      description: `Review a scenario with ${clampPercent(revenueUplift)}% revenue movement, ${clampPercent(costReduction)}% cost reduction and ${clampPercent(collectionLift)}% receivables collection lift. Projected profit is ${formatCeoCurrency(scenarioProfit)} and cash flow is ${formatCeoCurrency(scenarioCash)}.`,
      amount: ''
    });
    setDecisionError('');
  };

  const submitDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!decision || decisionSaving) return;
    setDecisionSaving(true);
    setDecisionError('');
    try {
      await api('/ceo/approvals', {
        method: 'POST',
        body: JSON.stringify({
          type: 'executive_intelligence',
          title: decision.title,
          description: decision.description,
          amount: decision.amount.trim() ? Number(decision.amount) : null,
          payload: {
            source: 'ceo_intelligence',
            generatedAt: summary.generatedAt,
            filters,
            assumptions: { revenueUplift: clampPercent(revenueUplift), costReduction: clampPercent(costReduction), collectionLift: clampPercent(collectionLift) }
          }
        })
      });
      setDecision(null);
      setMessage('Decision request saved in the CEO Approval Centre and audit trail.');
    } catch (problem) {
      setDecisionError(problem instanceof Error ? problem.message : 'Could not save the decision request.');
    } finally {
      setDecisionSaving(false);
    }
  };

  return <>
    <PageHeader eyebrow="EXECUTIVE INTELLIGENCE · CEO ONLY" title="CEO Executive Intelligence" description="A live control surface for the company’s money, momentum, delivery, people and decisions. Every operational link respects the existing CEO permissions." actions={<div className="ceo-header-actions"><button className="button button--secondary" type="button" onClick={() => navigate('/ceo-dashboard')}><ArrowLeft size={16} /> Dashboard</button><button className="button button--secondary" type="button" onClick={() => void query.refetch()}><RefreshCcw size={16} /> Refresh</button><button className="button" type="button" onClick={() => setDecision({ title: '', description: '', amount: '' })}><Send size={16} /> Raise decision</button></div>} />
    <section className="ceo-intelligence-hero">
      <div className="ceo-intelligence-hero__copy"><div className="ceo-intelligence-hero__badge"><BrainCircuit size={16} /> {features.length} CEO capabilities</div><h2>From signal to accountable action.</h2><p>{summary.executiveSummary}</p><small>Live snapshot generated {ceoDate(summary.generatedAt)} · Facts remain distinguishable from scenario recommendations.</small></div>
      <div className="ceo-intelligence-health"><span className="ceo-intelligence-health__ring"><strong>{summary.businessHealth.score}</strong><small>/100</small></span><div><span>BUSINESS HEALTH</span><strong>{summary.businessHealth.label}</strong><small>Portfolio · finance · people · governance</small></div></div>
    </section>
    {message && <div className="ceo-intelligence-message" role="status"><CheckCircle2 size={16} /> {message}</div>}
    <section className="ceo-intelligence-kpis" aria-label="CEO priority signals">
      <ExecutiveKpi icon={IndianRupee} label="Cash flow" value={formatCeoCurrency(summary.financial.cashFlow)} detail={`${formatCeoCurrency(summary.financial.receivables)} receivables`} tone="blue" />
      <ExecutiveKpi icon={BriefcaseBusiness} label="Portfolio risk" value={`${summary.projects.delayed} delayed`} detail={`${summary.projects.highRisk} high-risk`} tone="amber" />
      <ExecutiveKpi icon={UsersRound} label="Workforce" value={`${Math.round(summary.workforce.attendanceRate)}% present`} detail={`${summary.workforce.overtimeMinutes} overtime min`} tone="green" />
      <ExecutiveKpi icon={ClipboardCheck} label="Decisions" value={`${summary.approvals.pending} pending`} detail="CEO approval queue" tone="purple" />
    </section>
    <section className="ceo-intelligence-toolbar content-card">
      <div className="ceo-intelligence-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${features.length} capabilities…`} aria-label="Search CEO capabilities" /></div>
      <label className="field"><span>Domain</span><select value={category} onChange={(event) => setCategory(event.target.value as FeatureCategory | 'All')}><option value="All">All domains</option>{categoryOrder.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button className="text-button" type="button" onClick={() => { setSearch(''); setCategory('All'); setFrom(''); setTo(''); }}>Clear</button>
    </section>
    <section className="ceo-intelligence-domain-nav" aria-label="CEO intelligence domains">{categoryOrder.map((item) => { const Icon = categoryIcons[item]; const count = features.filter((entry) => entry.category === item).length; return <button type="button" key={item} title={categoryDescriptions[item]} className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}><Icon size={16} /><span><strong>{item}</strong><small>{count} capabilities</small></span><ArrowRight size={14} /></button>; })}</section>
    <section className="ceo-intelligence-grid" aria-label="CEO capabilities">{visibleFeatures.map((item) => { const Icon = categoryIcons[item.category]; return <article className="ceo-intelligence-feature" key={item.id}><div className="ceo-intelligence-feature__meta"><span className="ceo-intelligence-feature__icon"><Icon size={16} /></span><span>{item.category}</span><b>{item.id}</b></div><h3>{item.title}</h3><p>{item.detail}</p><div className="ceo-intelligence-feature__foot"><strong>{item.value(summary)}</strong><button type="button" onClick={() => openFeature(item)}>{actionLabel(item)} <ArrowRight size={14} /></button></div></article>; })}{!visibleFeatures.length && <div className="content-card ceo-empty-state"><Search size={25} /><strong>No CEO capability matches this search.</strong><span>Try another domain or clear the filter.</span></div>}</section>
    <section className="ceo-intelligence-lower-grid">
      <article className="content-card ceo-intelligence-scenario" id="ceo-scenario-lab"><div className="card-heading"><div><p className="eyebrow">DECISION SCIENCE</p><h2>Scenario lab</h2></div><Gauge size={20} /></div><p className="ceo-intelligence-panel-copy">Change assumptions to see a transparent directional model. Nothing is posted to the database until you explicitly raise a decision.</p><div className="ceo-scenario-inputs"><label className="field"><span>Revenue movement %</span><input type="number" min="-100" max="100" value={revenueUplift} onChange={(event) => setRevenueUplift(event.target.value)} /></label><label className="field"><span>Cost reduction %</span><input type="number" min="0" max="100" value={costReduction} onChange={(event) => setCostReduction(event.target.value)} /></label><label className="field"><span>Receivables collected %</span><input type="number" min="0" max="100" value={collectionLift} onChange={(event) => setCollectionLift(event.target.value)} /></label></div><div className="ceo-scenario-results"><ScenarioResult label="Projected revenue" value={formatCeoCurrency(scenarioRevenue)} /><ScenarioResult label="Projected costs" value={formatCeoCurrency(scenarioExpenses)} /><ScenarioResult label="Projected collections" value={formatCeoCurrency(scenarioCollections)} /><ScenarioResult label="Projected profit" value={formatCeoCurrency(scenarioProfit)} positive={scenarioProfit >= 0} /><ScenarioResult label="Projected cash flow" value={formatCeoCurrency(scenarioCash)} positive={scenarioCash >= 0} /></div><div className="ceo-intelligence-panel-actions"><button className="button button--secondary" type="button" onClick={() => document.getElementById('ceo-scenario-lab')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Focus lab</button><button className="button" type="button" onClick={raiseScenarioDecision}><Send size={15} /> Raise scenario decision</button></div></article>
      <article className="content-card ceo-intelligence-signals"><div className="card-heading"><div><p className="eyebrow">SIGNAL RADAR</p><h2>Critical activity</h2></div><Radar size={20} /></div><p className="ceo-intelligence-panel-copy">Recent activity matching risk, urgency, failure or overdue language, linked to the existing audit surface.</p>{summary.recentCriticalActivities.slice(0, 6).map((activity) => <button className="ceo-intelligence-signal" type="button" key={activity.id ?? `${activity.title}-${activity.at}`} onClick={() => navigate('/ceo/audit')}><span><AlertTriangle size={15} /></span><div><strong>{activity.title}</strong><small>{activity.detail || 'Open audit trail for evidence'}</small></div><time>{ceoDate(activity.at)}</time></button>)}{!summary.recentCriticalActivities.length && <div className="ceo-intelligence-no-signal"><CheckCircle2 size={20} /><span>No critical activity in this snapshot.</span></div>}<button className="text-button" type="button" onClick={() => navigate('/ceo/audit')}>Open full audit trail <ArrowRight size={15} /></button></article>
    </section>
    <p className="ceo-source-note">Authorised sources: {summary.sources.join(', ')}. This workspace presents CRM facts and transparent what-if calculations; recommendations require CEO review before action.</p>
    {decision && <DecisionDialog draft={decision} saving={decisionSaving} error={decisionError} onClose={() => { if (!decisionSaving) setDecision(null); }} onChange={setDecision} onSubmit={(event) => void submitDecision(event)} />}
  </>;
}

function ExecutiveKpi({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: string }) {
  return <div className={`ceo-intelligence-kpi ceo-intelligence-kpi--${tone}`}><span><Icon size={16} /></span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></div>;
}

function ScenarioResult({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return <div><small>{label}</small><strong className={positive === undefined ? '' : positive ? 'is-positive' : 'is-negative'}>{value}</strong></div>;
}

function DecisionDialog({ draft, saving, error, onClose, onChange, onSubmit }: { draft: DecisionDraft; saving: boolean; error: string; onClose: () => void; onChange: (draft: DecisionDraft) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal ceo-intelligence-decision-modal" role="dialog" aria-modal="true" aria-label="Raise executive decision" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">AUDITED EXECUTIVE ACTION</p><h2>Raise a decision request</h2></div><button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></div><p className="ceo-intelligence-panel-copy">This creates a pending record in the CEO Approval Centre. The request, context and actor are recorded by the existing server-side audit workflow.</p><form onSubmit={onSubmit}><div className="form-grid"><label className="field field--wide"><span>Decision title *</span><input required maxLength={255} value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} autoFocus /></label><label className="field field--wide"><span>Context and requested action *</span><textarea required rows={6} maxLength={10000} value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} /></label><label className="field"><span>Amount (optional)</span><input type="number" min="0" step="0.01" value={draft.amount} onChange={(event) => onChange({ ...draft, amount: event.target.value })} placeholder="₹ amount" /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save in approval centre'}</button></div></form></section></div>;
}

function actionLabel(item: ExecutiveFeature): string {
  if (item.action === 'scenario') return 'Open lab';
  if (item.action === 'decision') return 'Raise';
  if (item.action === 'clara') return item.title.toLowerCase().includes('clara') ? 'Ask Clara' : 'Activate';
  if (item.action === 'export') return 'Export';
  return 'Open';
}

function clampPercent(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-100, Math.min(100, parsed));
}

async function downloadCeoCsv(): Promise<void> {
  const token = getAccessToken();
  const response = await fetch(apiUrl('/ceo/reports/summary?format=csv'), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ceo-executive-intelligence.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

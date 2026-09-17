import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  Layers3,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  UsersRound,
  type LucideIcon
} from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/LoadingState.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, queryString } from '../lib/api.js';
import { ceoDate, formatCeoCurrency, isCeoRole } from '../lib/ceo.js';
import { useAuth } from '../store/auth.js';

interface AiModel {
  id: string;
  name: string;
  family: string;
  status: string;
  explanation: string;
}

interface AiForecast {
  id: string;
  metric: string;
  current30d: number;
  projected30d: number;
  projected90d: number;
  trend: 'up' | 'down' | 'stable';
  confidence: number;
  method: string;
  explanation: string;
}

interface AiAnomaly {
  id: string;
  domain: string;
  title: string;
  severity: 'critical' | 'warning' | 'watch';
  score: number;
  signal: string;
  evidence: string;
  href: string;
}

interface AiRisk {
  id: string;
  domain: string;
  score: number;
  label: string;
  drivers: string[];
  href: string;
}

interface AiRecommendation {
  id: string;
  priority: 'now' | 'soon' | 'watch';
  title: string;
  reason: string;
  expectedImpact: string;
  confidence: number;
  requiresApproval: boolean;
  href: string;
}

interface AiInsights {
  generatedAt: string;
  period: { from: string; to: string; lookbackDays: number };
  modelStack: AiModel[];
  dataQuality: { score: number; label: string; observations: number; populatedSources: number; totalSources: number; activeDays: number; latestData: string | null; limitations: string[] };
  forecasts: AiForecast[];
  anomalies: AiAnomaly[];
  riskScores: AiRisk[];
  clientSegments: Array<{ name: string; count: number; definition: string }>;
  topAccounts: Array<{ name: string; revenue: number; collected: number; collectionRate: number; segment: string; href: string }>;
  recommendations: AiRecommendation[];
  deepLearningReadiness: { score: number; label: string; currentMode: string; blockers: string[]; nextSteps: string[] };
}

type CapabilityState = 'Live' | 'Foundation';
interface AiCapability { title: string; family: string; detail: string; state: CapabilityState }

const capabilities: AiCapability[] = [
  { title: 'Revenue time-series forecast', family: 'Forecasting', detail: 'Projects the next 30 and 90 days from historical invoice signals.', state: 'Live' },
  { title: 'Collections forecast', family: 'Forecasting', detail: 'Projects cash collection momentum from payment events.', state: 'Live' },
  { title: 'Expense forecast', family: 'Forecasting', detail: 'Models near-term cost direction using recorded expenses.', state: 'Live' },
  { title: 'Trend confidence scoring', family: 'Forecasting', detail: 'Shows signal strength instead of presenting every forecast as certain.', state: 'Live' },
  { title: 'Robust anomaly detection', family: 'Data science', detail: 'Finds unusual daily values against the metric’s own baseline.', state: 'Live' },
  { title: 'Median absolute deviation', family: 'Data science', detail: 'Reduces sensitivity to a single extreme value when measuring outliers.', state: 'Live' },
  { title: 'Daily signal baselines', family: 'Data science', detail: 'Converts event records into comparable daily feature series.', state: 'Live' },
  { title: 'Finance risk classification', family: 'Machine learning', detail: 'Weights overdue, cost, collection and anomaly pressure into a visible score.', state: 'Live' },
  { title: 'Delivery risk classification', family: 'Machine learning', detail: 'Combines late projects, high-risk flags and late tasks.', state: 'Live' },
  { title: 'People risk classification', family: 'Machine learning', detail: 'Combines attendance deviation and overtime pressure.', state: 'Live' },
  { title: 'Governance risk classification', family: 'Machine learning', detail: 'Prioritises unresolved executive approvals for review.', state: 'Live' },
  { title: 'Client feature vectors', family: 'Machine learning', detail: 'Builds account vectors from revenue, collection and activity.', state: 'Live' },
  { title: 'Account clustering', family: 'Machine learning', detail: 'Groups accounts into strategic, growth and emerging/watch segments.', state: 'Live' },
  { title: 'Account concentration watch', family: 'Machine learning', detail: 'Surfaces the highest-value accounts for dependency review.', state: 'Live' },
  { title: 'Next-best-action recommendations', family: 'Decision intelligence', detail: 'Creates prioritised actions from the strongest current signals.', state: 'Live' },
  { title: 'Human-in-the-loop approvals', family: 'Decision intelligence', detail: 'Routes proposed sensitive actions into the audited approval centre.', state: 'Live' },
  { title: 'Evidence-linked recommendations', family: 'Decision intelligence', detail: 'Shows the operational reason behind each suggested action.', state: 'Live' },
  { title: 'Recommendation confidence', family: 'Decision intelligence', detail: 'Separates strong evidence from lower-confidence watch items.', state: 'Live' },
  { title: 'Data freshness monitoring', family: 'MLOps', detail: 'Reports the newest observed record and the active signal window.', state: 'Live' },
  { title: 'Source coverage monitoring', family: 'MLOps', detail: 'Shows how many operational collections contributed evidence.', state: 'Live' },
  { title: 'Feature quality score', family: 'MLOps', detail: 'Combines observations, source population and active-day coverage.', state: 'Live' },
  { title: 'Model limitation register', family: 'MLOps', detail: 'Keeps prediction boundaries visible to the executive reviewer.', state: 'Live' },
  { title: 'Sequence data readiness', family: 'Deep learning', detail: 'Measures longitudinal coverage before a sequence model can be trusted.', state: 'Foundation' },
  { title: 'Outcome-label design', family: 'Deep learning', detail: 'Prepares approved business outcomes for future supervised learning.', state: 'Foundation' },
  { title: 'Feature snapshot versioning', family: 'Deep learning', detail: 'Defines the requirement for reproducible training data.', state: 'Foundation' },
  { title: 'Holdout-period evaluation', family: 'Deep learning', detail: 'Defines the requirement for testing future predictions honestly.', state: 'Foundation' },
  { title: 'Drift monitoring', family: 'Deep learning', detail: 'Defines the control needed when real-world behaviour changes.', state: 'Foundation' },
  { title: 'Bias and safety review', family: 'Deep learning', detail: 'Keeps workforce and financial automation subject to human review.', state: 'Foundation' },
  { title: 'Model registry governance', family: 'Deep learning', detail: 'Separates candidate experiments from production decision systems.', state: 'Foundation' },
  { title: 'AI outage fallback', family: 'Trust and safety', detail: 'Keeps explainable local analytics available if an external provider is unavailable.', state: 'Live' },
  { title: 'Permission-aware intelligence', family: 'Trust and safety', detail: 'Uses the existing CEO-protected server route and authorised CRM scope.', state: 'Live' }
];

const familyIcons: Record<string, LucideIcon> = {
  Forecasting: TrendingUp,
  'Data science': Activity,
  'Machine learning': Target,
  'Decision intelligence': Sparkles,
  MLOps: Database,
  'Deep learning': BrainCircuit,
  'Trust and safety': ShieldCheck
};

export function CeoAiInsightsPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const allowed = isCeoRole(user?.role) || hasPermission('ceo.dashboard');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('All');
  const query = useQuery({
    queryKey: ['ceo-ai-insights', from, to],
    enabled: allowed,
    queryFn: () => api<AiInsights>(`/ceo/ai-insights${queryString({ from, to })}`)
  });

  if (!allowed) return <Navigate to="/dashboard" replace />;
  if (query.isPending) return <LoadingState label="Running explainable CEO intelligence models…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const insights = query.data;
  const families = ['All', ...new Set(capabilities.map((capability) => capability.family))];
  const visibleCapabilities = capabilities.filter((capability) => capabilityFilter === 'All' || capability.family === capabilityFilter);
  return <>
    <PageHeader eyebrow="AI · DATA SCIENCE · ML · DEEP LEARNING" title="CEO AI Insight Centre" description="Explainable forecasts, anomaly detection, risk classification and decision recommendations over authorised KAKI CRM data." actions={<div className="ceo-header-actions"><button className="button button--secondary" type="button" onClick={() => navigate('/ceo/intelligence')}><ArrowLeft size={16} /> Intelligence</button><button className="button button--secondary" type="button" onClick={() => void query.refetch()}><RefreshCcw size={16} /> Recalculate</button></div>} />
    <section className="ceo-ai-hero"><div className="ceo-ai-hero__copy"><div className="ceo-ai-hero__badge"><Sparkles size={15} /> Human-reviewed intelligence</div><h2>Predict earlier. Explain clearly. Act safely.</h2><p>The current engine uses local, inspectable algorithms over CRM records. It gives the CEO a useful intelligence layer today while measuring the evidence required before deploying a deep-learning model.</p><small>Snapshot: {ceoDate(insights.generatedAt)} · Lookback: {insights.period.lookbackDays} days · No prediction is treated as a guaranteed outcome.</small></div><div className="ceo-ai-hero__mode"><BrainCircuit size={22} /><div><strong>Explainable AI mode</strong><span>Forecasting, anomaly and risk models live</span><small>External AI outage does not stop the CRM</small></div></div></section>
    <section className="ceo-ai-controls content-card"><div className="ceo-ai-control-copy"><Clock3 size={17} /><div><strong>Analysis window</strong><span>Change the period used by the analytics engine.</span></div></div><label className="field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label className="field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="text-button" type="button" onClick={() => { setFrom(''); setTo(''); }}>Use 90-day default</button></section>
    <section className="ceo-ai-overview-grid"><AiOverviewCard icon={Gauge} label="Data quality" value={`${insights.dataQuality.score}/100`} detail={insights.dataQuality.label} tone={insights.dataQuality.score >= 70 ? 'green' : 'amber'} /><AiOverviewCard icon={Layers3} label="Observations" value={insights.dataQuality.observations.toLocaleString('en-IN')} detail={`${insights.dataQuality.populatedSources}/${insights.dataQuality.totalSources} sources populated`} tone="blue" /><AiOverviewCard icon={BrainCircuit} label="Deep-learning readiness" value={`${insights.deepLearningReadiness.score}/100`} detail={insights.deepLearningReadiness.label} tone="purple" /><AiOverviewCard icon={ShieldAlert} label="Signals" value={`${insights.anomalies.length} anomalies`} detail={`${insights.recommendations.length} recommendations`} tone="red" /></section>
    <section className="ceo-ai-model-grid">{insights.modelStack.map((model) => <article className="content-card ceo-ai-model-card" key={model.id}><div className="ceo-ai-model-card__head"><span><BrainCircuit size={16} /></span><div><strong>{model.name}</strong><small>{model.family}</small></div><b className={model.status === 'live' || model.status === 'pilot ready' ? 'is-live' : 'is-foundation'}>{model.status}</b></div><p>{model.explanation}</p></article>)}</section>
    <section className="ceo-ai-main-grid"><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">PREDICTIVE ANALYTICS</p><h2>Forecast horizon</h2></div><BarChart3 size={20} /></div><div className="ceo-ai-forecast-list">{insights.forecasts.map((forecast) => <ForecastCard key={forecast.id} forecast={forecast} />)}</div><p className="ceo-ai-footnote">Forecast method and confidence are shown per metric. Sparse or flat histories fall back to a moving average.</p></article><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">RISK CLASSIFICATION</p><h2>Executive risk map</h2></div><Target size={20} /></div><div className="ceo-ai-risk-list">{insights.riskScores.map((risk) => <RiskCard key={risk.id} risk={risk} onOpen={() => navigate(risk.href)} />)}</div><p className="ceo-ai-footnote">Scores are explainable indicators, not automated decisions. Drivers remain visible for review.</p></article></section>
    <section className="ceo-ai-main-grid"><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">OUTLIER DETECTION</p><h2>Unusual signals</h2></div><AlertTriangle size={20} /></div>{insights.anomalies.length ? <div className="ceo-ai-anomaly-list">{insights.anomalies.map((anomaly) => <button className="ceo-ai-anomaly" type="button" key={anomaly.id} onClick={() => navigate(anomaly.href)}><span className={`ceo-ai-anomaly__icon ceo-ai-anomaly__icon--${anomaly.severity}`}><AlertTriangle size={15} /></span><div><strong>{anomaly.title}</strong><small>{anomaly.signal}</small><em>{anomaly.evidence}</em></div><b>{anomaly.score}</b></button>)}</div> : <div className="ceo-ai-empty"><CheckCircle2 size={20} /><span>No unusual signal crossed the current threshold.</span></div>}</article><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">NEXT-BEST-ACTION</p><h2>Recommendations</h2></div><Sparkles size={20} /></div><div className="ceo-ai-recommendation-list">{insights.recommendations.map((recommendation) => <button className="ceo-ai-recommendation" type="button" key={recommendation.id} onClick={() => navigate(recommendation.href)}><span className={`ceo-ai-priority ceo-ai-priority--${recommendation.priority}`}>{recommendation.priority}</span><div><strong>{recommendation.title}</strong><small>{recommendation.reason}</small><em>{recommendation.expectedImpact} · {recommendation.confidence}% confidence</em></div>{recommendation.requiresApproval && <b>Approval</b>}</button>)}</div></article></section>
    <section className="ceo-ai-main-grid"><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">UNSUPERVISED LEARNING</p><h2>Account segments</h2></div><UsersRound size={20} /></div><div className="ceo-ai-segment-list">{insights.clientSegments.map((segment) => <div className="ceo-ai-segment" key={segment.name}><span><strong>{segment.count}</strong><small>accounts</small></span><div><strong>{segment.name}</strong><p>{segment.definition}</p></div></div>)}</div></article><article className="content-card ceo-ai-panel"><div className="card-heading"><div><p className="eyebrow">DEEP-LEARNING GATE</p><h2>{insights.deepLearningReadiness.label}</h2></div><BrainCircuit size={20} /></div><div className="ceo-ai-readiness-meter"><span style={{ width: `${insights.deepLearningReadiness.score}%` }} /></div><strong className="ceo-ai-readiness-score">{insights.deepLearningReadiness.score}/100 readiness</strong><p className="ceo-ai-panel-copy">{insights.deepLearningReadiness.currentMode}</p><div className="ceo-ai-readiness-columns"><div><small>Blockers</small><ul>{insights.deepLearningReadiness.blockers.map((item) => <li key={item}>{item}</li>)}</ul></div><div><small>Next steps</small><ul>{insights.deepLearningReadiness.nextSteps.map((item) => <li key={item}>{item}</li>)}</ul></div></div></article></section>
    <section className="content-card ceo-ai-panel ceo-ai-accounts"><div className="card-heading"><div><p className="eyebrow">ACCOUNT INTELLIGENCE</p><h2>Highest-value accounts</h2></div><button className="text-button" type="button" onClick={() => navigate('/data/clients')}>All clients <ArrowRight size={15} /></button></div><div className="ceo-ai-account-table"><div className="ceo-ai-account-table__head"><span>Account</span><span>Revenue</span><span>Collected</span><span>Collection</span><span>Segment</span></div>{insights.topAccounts.map((account) => <button type="button" key={account.href} onClick={() => navigate(account.href)}><strong>{account.name}</strong><span>{formatCeoCurrency(account.revenue)}</span><span>{formatCeoCurrency(account.collected)}</span><span>{account.collectionRate}%</span><em>{account.segment}</em></button>)}{!insights.topAccounts.length && <p className="muted-copy">No linked account activity in this window.</p>}</div></section>
    <section className="content-card ceo-ai-panel ceo-ai-capabilities"><div className="card-heading"><div><p className="eyebrow">AI CAPABILITY MAP</p><h2>What is live versus being prepared</h2></div><ShieldCheck size={20} /></div><div className="ceo-ai-capability-toolbar"><div className="ceo-ai-capability-tabs">{families.map((family) => <button className={capabilityFilter === family ? 'is-active' : ''} type="button" key={family} onClick={() => setCapabilityFilter(family)}>{family}</button>)}</div><span>{visibleCapabilities.length} capabilities</span></div><div className="ceo-ai-capability-grid">{visibleCapabilities.map((capability) => { const Icon = familyIcons[capability.family] ?? BrainCircuit; return <article key={capability.title}><span className="ceo-ai-capability-icon"><Icon size={15} /></span><div><strong>{capability.title}</strong><small>{capability.family}</small><p>{capability.detail}</p></div><b className={capability.state === 'Live' ? 'is-live' : 'is-foundation'}>{capability.state}</b></article>; })}</div></section>
    <section className="ceo-ai-limitations"><div><ShieldCheck size={17} /><strong>Governance built in</strong><span>AI never silently approves, deletes, changes salary or exposes unauthorised records.</span></div><div><Database size={17} /><strong>Latest data</strong><span>{insights.dataQuality.latestData ? ceoDate(insights.dataQuality.latestData) : 'No dated records found'}</span></div><div><Gauge size={17} /><strong>Known limits</strong><span>{insights.dataQuality.limitations[0]}</span></div></section>
  </>;
}

function AiOverviewCard({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: string }) {
  return <article className={`ceo-ai-overview-card ceo-ai-overview-card--${tone}`}><span><Icon size={17} /></span><div><small>{label}</small><strong>{value}</strong><em>{detail}</em></div></article>;
}

function ForecastCard({ forecast }: { forecast: AiForecast }) {
  const TrendIcon = forecast.trend === 'down' ? TrendingDown : forecast.trend === 'up' ? TrendingUp : Activity;
  return <div className="ceo-ai-forecast-card"><div className="ceo-ai-forecast-card__top"><strong>{forecast.metric}</strong><span className={`ceo-ai-trend ceo-ai-trend--${forecast.trend}`}><TrendIcon size={14} /> {forecast.trend}</span></div><div className="ceo-ai-forecast-values"><div><small>Current 30d</small><strong>{formatCeoCurrency(forecast.current30d)}</strong></div><div><small>Projected 30d</small><strong>{formatCeoCurrency(forecast.projected30d)}</strong></div><div><small>Projected 90d</small><strong>{formatCeoCurrency(forecast.projected90d)}</strong></div><div><small>Confidence</small><strong>{forecast.confidence}%</strong></div></div><small className="ceo-ai-forecast-method">{forecast.method} · {forecast.explanation}</small></div>;
}

function RiskCard({ risk, onOpen }: { risk: AiRisk; onOpen: () => void }) {
  return <button className="ceo-ai-risk-card" type="button" onClick={onOpen}><div className="ceo-ai-risk-card__top"><span>{risk.domain}</span><b className={risk.score >= 75 ? 'is-critical' : risk.score >= 50 ? 'is-watch' : 'is-controlled'}>{risk.label}</b></div><div className="ceo-ai-risk-meter"><span style={{ width: `${risk.score}%` }} /></div><div className="ceo-ai-risk-card__bottom"><strong>{risk.score}/100</strong><small>{risk.drivers.filter((driver) => !driver.toLowerCase().includes('no ')).slice(0, 2).join(' · ')}</small><ArrowRight size={14} /></div></button>;
}

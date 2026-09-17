import { type LegacyRecord } from '../db/legacy.js';
import { listRawRecords } from './legacyRepository.js';

export interface CeoAiInsightFilters {
  from?: string;
  to?: string;
}

export interface CeoAiInsights {
  generatedAt: string;
  period: { from: string; to: string; lookbackDays: number };
  modelStack: Array<{ id: string; name: string; family: string; status: string; explanation: string }>;
  dataQuality: { score: number; label: string; observations: number; populatedSources: number; totalSources: number; activeDays: number; latestData: string | null; limitations: string[] };
  forecasts: Array<{ id: string; metric: string; current30d: number; projected30d: number; projected90d: number; trend: 'up' | 'down' | 'stable'; confidence: number; method: string; explanation: string }>;
  anomalies: Array<{ id: string; domain: string; title: string; severity: 'critical' | 'warning' | 'watch'; score: number; signal: string; evidence: string; href: string }>;
  riskScores: Array<{ id: string; domain: string; score: number; label: string; drivers: string[]; href: string }>;
  clientSegments: Array<{ name: string; count: number; definition: string }>;
  topAccounts: Array<{ name: string; revenue: number; collected: number; collectionRate: number; segment: string; href: string }>;
  recommendations: Array<{ id: string; priority: 'now' | 'soon' | 'watch'; title: string; reason: string; expectedImpact: string; confidence: number; requiresApproval: boolean; href: string }>;
  deepLearningReadiness: { score: number; label: string; currentMode: string; blockers: string[]; nextSteps: string[] };
}

interface SeriesPoint {
  day: string;
  value: number;
}

interface ForecastCalculation {
  current30d: number;
  projected30d: number;
  projected90d: number;
  trend: 'up' | 'down' | 'stable';
  confidence: number;
  method: string;
}

interface ClientPoint {
  id: number;
  name: string;
  revenue: number;
  collected: number;
  invoices: number;
  leads: number;
  quotations: number;
}

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 90;

export async function buildCeoAiInsights(filters: CeoAiInsightFilters = {}): Promise<CeoAiInsights> {
  const to = endOfDay(parseDate(filters.to) ?? new Date());
  const requestedFrom = startOfDay(parseDate(filters.from) ?? new Date(to.valueOf() - (LOOKBACK_DAYS - 1) * DAY_MS));
  const from = new Date(Math.min(requestedFrom.valueOf(), to.valueOf() - DAY_MS));
  const lookbackDays = Math.max(2, Math.min(365, Math.ceil((to.valueOf() - from.valueOf()) / DAY_MS) + 1));

  const [invoices, expenses, payments, projects, tasks, users, attendance, overtime, payroll, clients, leads, quotations, approvals, activities] = await Promise.all([
    listRawRecords('invoices', {}, 50_000),
    listRawRecords('expenses', {}, 30_000),
    listRawRecords('payments', {}, 50_000),
    listRawRecords('department_projects', {}, 20_000),
    listRawRecords('tasks', {}, 50_000),
    listRawRecords('users', {}, 20_000),
    listRawRecords('attendance_logs', {}, 50_000),
    listRawRecords('attendance_overtime', {}, 50_000),
    listRawRecords('payroll_monthly', {}, 30_000),
    listRawRecords('clients', {}, 20_000),
    listRawRecords('leads', {}, 20_000),
    listRawRecords('quotations', {}, 20_000),
    listRawRecords('ceo_approvals', {}, 10_000),
    listRawRecords('activity_logs', {}, 500)
  ]);

  const sourceRecords = { invoices, expenses, payments, projects, tasks, users, attendance, overtime, payroll, clients, leads, quotations, approvals, activities };
  const revenueRecords = scoped(invoices, from, to);
  const expenseRecords = scoped(expenses, from, to);
  const paymentRecords = scoped(payments, from, to);
  const projectRecords = scoped(projects, from, to);
  const taskRecords = scoped(tasks, from, to);
  const attendanceRecords = scoped(attendance, from, to);
  const overtimeRecords = scoped(overtime, from, to);

  const revenueSeries = dailySeries(revenueRecords, from, to, (record) => amount(record.raw, ['total_amount', 'total', 'grand_total', 'amount', 'value']));
  const collectionSeries = dailySeries(paymentRecords, from, to, (record) => amount(record.raw, ['amount', 'paid_amount', 'payment_amount', 'value']));
  const expenseSeries = dailySeries(expenseRecords, from, to, (record) => amount(record.raw, ['amount', 'total', 'expense_amount', 'value', 'cost']));
  const overdueInvoices = revenueRecords.filter((record) => isOverdueInvoice(record, to)).length;
  const delayedProjects = projectRecords.filter((record) => isDelayedProject(record, to)).length;
  const highRiskProjects = projectRecords.filter((record) => isHighRiskProject(record)).length;
  const openTasks = taskRecords.filter((record) => normalizeStatus(record.raw.status) !== 'completed');
  const delayedTasks = openTasks.filter((record) => isBefore(parseDate(firstValue(record.raw, ['due_date', 'deadline'])), to));
  const activeUsers = users.filter((record) => isActive(record.raw.status));
  const latestAttendanceDay = latestDay(attendanceRecords);
  const latestAttendance = latestAttendanceDay ? attendanceRecords.filter((record) => dayKey(recordDate(record)) === latestAttendanceDay).length : 0;
  const attendanceRate = activeUsers.length ? (latestAttendance / activeUsers.length) * 100 : 0;
  const overtimeMinutes = overtimeRecords.reduce((sum, record) => sum + amount(record.raw, ['overtime_minutes', 'overtime', 'ot_minutes']), 0);
  const invoiceValue = revenueRecords.reduce((sum, record) => sum + amount(record.raw, ['total_amount', 'total', 'grand_total', 'amount', 'value']), 0);
  const collectedValue = paymentRecords.reduce((sum, record) => sum + amount(record.raw, ['amount', 'paid_amount', 'payment_amount', 'value']), 0);
  const expenseValue = expenseRecords.reduce((sum, record) => sum + amount(record.raw, ['amount', 'total', 'expense_amount', 'value', 'cost']), 0);
  const forecasts = [
    makeForecast('revenue', 'Revenue', revenueSeries, 'Invoices', 'Revenue is based on invoice values recorded in the selected period.'),
    makeForecast('collections', 'Collections', collectionSeries, 'Payments', 'Collections are based on payment events recorded in the selected period.'),
    makeForecast('expenses', 'Expenses', expenseSeries, 'Expenses', 'Expenses are based on recorded expense entries in the selected period.')
  ];

  const anomalies = [
    ...detectSeriesAnomalies(revenueSeries, 'Finance', 'Revenue spike', 'Revenue activity materially differs from its recent baseline.', '/invoices'),
    ...detectSeriesAnomalies(collectionSeries, 'Finance', 'Collection spike', 'Payment activity materially differs from its recent baseline.', '/data/payments'),
    ...detectSeriesAnomalies(expenseSeries, 'Finance', 'Expense spike', 'Expense activity materially differs from its recent baseline.', '/data/expenses')
  ];
  if (overdueInvoices > 0) anomalies.push({ id: 'anomaly-overdue-invoices', domain: 'Finance', title: 'Overdue invoice cluster', severity: overdueInvoices >= 5 ? 'critical' : 'warning', score: Math.min(100, 45 + overdueInvoices * 8), signal: `${overdueInvoices} invoice${overdueInvoices === 1 ? '' : 's'} are overdue.`, evidence: 'Collection risk is calculated from invoice due dates and current status.', href: '/invoices' });
  if (delayedProjects + delayedTasks.length > 0) anomalies.push({ id: 'anomaly-delivery-pressure', domain: 'Delivery', title: 'Delivery pressure detected', severity: delayedProjects + delayedTasks.length >= 8 ? 'critical' : 'warning', score: Math.min(100, 40 + (delayedProjects * 9) + (delayedTasks.length * 3)), signal: `${delayedProjects} delayed project${delayedProjects === 1 ? '' : 's'} and ${delayedTasks.length} late task${delayedTasks.length === 1 ? '' : 's'}.`, evidence: 'Schedule risk is calculated from due dates, project status and task status.', href: '/projects' });
  if (activeUsers.length > 0 && attendanceRate < 80) anomalies.push({ id: 'anomaly-attendance', domain: 'People', title: 'Attendance deviation', severity: attendanceRate < 60 ? 'critical' : 'warning', score: Math.min(100, Math.round(100 - attendanceRate)), signal: `Latest recorded attendance is ${Math.round(attendanceRate)}%.`, evidence: 'Attendance is compared with the active employee population.', href: '/attendance' });
  const sortedAnomalies = anomalies.sort((a, b) => b.score - a.score).slice(0, 10);

  const clientPointData = buildClientPoints(clients, invoices, payments, leads, quotations, from, to);
  const clientSegments = segmentClients(clientPointData);
  const topAccounts = clientPointData.sort((a, b) => b.revenue - a.revenue).slice(0, 8).map((client) => ({
    name: client.name,
    revenue: round(client.revenue),
    collected: round(client.collected),
    collectionRate: client.revenue > 0 ? Math.round((client.collected / client.revenue) * 100) : 0,
    segment: segmentForClient(client, clientPointData),
    href: `/data/clients/${client.id}`
  }));

  const riskScores = [
    riskScore('finance-risk', 'Finance', scoreFinanceRisk({ overdueInvoices, invoiceCount: revenueRecords.length, expenseValue, invoiceValue, collectedValue, anomalies: sortedAnomalies }), [
      overdueInvoices ? `${overdueInvoices} overdue invoices` : 'No overdue invoices detected',
      invoiceValue > 0 ? `${Math.round((expenseValue / invoiceValue) * 100)}% expense-to-invoice ratio` : 'No invoice value in period',
      forecasts[0].trend === 'down' ? 'Revenue baseline is trending down' : 'Revenue baseline is stable or improving'
    ], '/ceo/approvals'),
    riskScore('delivery-risk', 'Delivery', scoreDeliveryRisk({ delayedProjects, highRiskProjects, activeProjects: projectRecords.filter((record) => normalizeStatus(record.raw.status) === 'active').length, delayedTasks: delayedTasks.length }), [
      `${delayedProjects} delayed projects`,
      `${highRiskProjects} high-risk projects`,
      `${delayedTasks.length} late tasks`
    ], '/projects'),
    riskScore('people-risk', 'People', scorePeopleRisk({ attendanceRate, overtimeMinutes, activeEmployees: activeUsers.length }), [
      `${Math.round(attendanceRate)}% latest attendance`,
      `${Math.round(overtimeMinutes)} overtime minutes`,
      activeUsers.length ? `${Math.round(overtimeMinutes / activeUsers.length)} minutes per active employee` : 'No active employee baseline'
    ], '/workforce'),
    riskScore('governance-risk', 'Governance', Math.min(100, approvals.filter((record) => normalizeStatus(record.raw.status) === 'pending').length * 9), [
      `${approvals.filter((record) => normalizeStatus(record.raw.status) === 'pending').length} pending approvals`,
      'Approval actions remain permission-checked and auditable'
    ], '/ceo/approvals')
  ];

  const recommendations = buildRecommendations({ overdueInvoices, delayedProjects, delayedTasks: delayedTasks.length, attendanceRate, overtimeMinutes, activeUsers: activeUsers.length, expenseValue, invoiceValue, forecasts, sortedAnomalies });
  const allDates = Object.values(sourceRecords).flatMap((records) => records.slice(0, 200).map((record) => recordDate(record)?.valueOf() ?? 0)).filter((value) => value > 0);
  const latestData = allDates.length ? new Date(Math.max(...allDates)).toISOString() : null;
  const populatedSources = Object.values(sourceRecords).filter((records) => records.length > 0).length;
  const activeDays = new Set([...revenueSeries, ...collectionSeries, ...expenseSeries].filter((point) => point.value > 0).map((point) => point.day)).size;
  const observations = Object.values(sourceRecords).reduce((sum, records) => sum + records.length, 0);
  const dataQualityScore = Math.min(100, Math.round((populatedSources / Object.keys(sourceRecords).length) * 60 + Math.min(1, activeDays / Math.min(lookbackDays, LOOKBACK_DAYS)) * 25 + Math.min(1, observations / 500) * 15));
  const deepLearningReadiness = buildDeepLearningReadiness({ observations, populatedSources, totalSources: Object.keys(sourceRecords).length, activeDays, lookbackDays });

  return {
    generatedAt: new Date().toISOString(),
    period: { from: from.toISOString(), to: to.toISOString(), lookbackDays },
    modelStack: [
      { id: 'forecast', name: 'Executive forecasting', family: 'Time-series regression + moving average', status: 'live', explanation: 'Uses recent CRM time series, trend slope and signal strength to produce directional projections.' },
      { id: 'anomaly', name: 'Anomaly detection', family: 'Robust z-score / MAD', status: 'live', explanation: 'Flags observations that materially depart from their own recent baseline.' },
      { id: 'risk', name: 'Risk classification', family: 'Explainable weighted scoring', status: 'live', explanation: 'Scores finance, delivery, people and governance risk using visible drivers.' },
      { id: 'segments', name: 'Account segmentation', family: 'Feature-vector clustering', status: clientPointData.length >= 3 ? 'live' : 'needs data', explanation: 'Groups accounts by revenue, collection behaviour and commercial activity.' },
      { id: 'deep-learning', name: 'Deep-learning readiness', family: 'Sequence feature quality', status: deepLearningReadiness.score >= 70 ? 'pilot ready' : 'collecting data', explanation: 'Measures whether KAKI has enough clean longitudinal observations for a future sequence model; no black-box model is silently deployed.' }
    ],
    dataQuality: { score: dataQualityScore, label: dataQualityScore >= 80 ? 'Strong foundation' : dataQualityScore >= 55 ? 'Usable with gaps' : 'Needs instrumentation', observations, populatedSources, totalSources: Object.keys(sourceRecords).length, activeDays, latestData, limitations: ['Predictions are directional and should not be treated as guaranteed outcomes.', 'Historical quality depends on the completeness and date accuracy of imported CRM records.', 'Deep-learning serving is not enabled until a reviewed model, labels, monitoring and approval process are configured.'] },
    forecasts,
    anomalies: sortedAnomalies,
    riskScores,
    clientSegments,
    topAccounts,
    recommendations,
    deepLearningReadiness
  };
}

function scoped(records: LegacyRecord[], from: Date, to: Date): LegacyRecord[] {
  return records.filter((record) => {
    const date = recordDate(record);
    return Boolean(date && date.valueOf() >= from.valueOf() && date.valueOf() <= to.valueOf());
  });
}

function dailySeries(records: LegacyRecord[], from: Date, to: Date, mapper: (record: LegacyRecord) => number): SeriesPoint[] {
  const days = Math.max(2, Math.ceil((to.valueOf() - from.valueOf()) / DAY_MS) + 1);
  const values = new Map<string, number>();
  for (let index = 0; index < days; index += 1) values.set(dayKey(new Date(from.valueOf() + index * DAY_MS)), 0);
  for (const record of records) {
    const date = recordDate(record);
    if (!date) continue;
    const key = dayKey(date);
    if (values.has(key)) values.set(key, (values.get(key) ?? 0) + Math.max(0, mapper(record)));
  }
  return [...values.entries()].map(([day, value]) => ({ day, value: round(value) }));
}

function makeForecast(id: string, metric: string, series: SeriesPoint[], source: string, explanation: string): CeoAiInsights['forecasts'][number] {
  const calculation = calculateForecast(series);
  return { id, metric, ...calculation, method: `${calculation.method} · ${source}`, explanation };
}

function calculateForecast(series: SeriesPoint[]): ForecastCalculation {
  const values = series.map((point) => point.value);
  const current30d = round(values.slice(-30).reduce((sum, value) => sum + value, 0));
  const regression = linearRegression(values);
  const recent = values.slice(-30);
  const recentAverage = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
  const modelDaily = regression.rSquared >= 0.12 ? (horizon: number) => Math.max(0, regression.intercept + regression.slope * (values.length + horizon)) : () => Math.max(0, recentAverage);
  const projected30d = round(sumRange(1, 30, modelDaily));
  const projected90d = round(sumRange(1, 90, modelDaily));
  const baseline = Math.max(1, recentAverage);
  const relativeSlope = regression.slope / baseline;
  const trend = relativeSlope > 0.01 ? 'up' : relativeSlope < -0.01 ? 'down' : 'stable';
  const nonZeroDays = values.filter((value) => value > 0).length;
  const confidence = Math.max(15, Math.min(95, Math.round((nonZeroDays / Math.max(1, values.length)) * 55 + regression.rSquared * 45)));
  const method = regression.rSquared >= 0.12 ? 'Linear trend' : '30-day moving average';
  return { current30d, projected30d, projected90d, trend, confidence, method };
}

function detectSeriesAnomalies(series: SeriesPoint[], domain: string, title: string, evidence: string, href: string): CeoAiInsights['anomalies'] {
  const values = series.map((point) => point.value).filter((value) => value > 0);
  if (values.length < 4) return [];
  const median = percentile(values, 0.5);
  const mad = percentile(values.map((value) => Math.abs(value - median)), 0.5);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
  return series.map((point) => {
    const robustScore = mad > 0 ? Math.abs(point.value - median) / (1.4826 * mad) : deviation > 0 ? Math.abs(point.value - mean) / deviation : 0;
    return { point, robustScore };
  }).filter(({ point, robustScore }) => point.value > 0 && robustScore >= 2.5).map(({ point, robustScore }) => ({
    id: `anomaly-${domain.toLowerCase()}-${point.day}`,
    domain,
    title,
    severity: robustScore >= 4 ? 'critical' : robustScore >= 3 ? 'warning' : 'watch',
    score: Math.min(100, Math.round(robustScore * 20)),
    signal: `${point.day}: ${formatAmount(point.value)} versus a ${formatAmount(median)} baseline.`,
    evidence,
    href
  }));
}

function buildClientPoints(clients: LegacyRecord[], invoices: LegacyRecord[], payments: LegacyRecord[], leads: LegacyRecord[], quotations: LegacyRecord[], from: Date, to: Date): ClientPoint[] {
  const points = new Map<number, ClientPoint>();
  const names = new Map<number, string>();
  for (const client of clients) {
    const id = client.legacyId ?? numeric(client.raw.id);
    if (!id) continue;
    names.set(id, String(client.raw.name ?? client.raw.company ?? `Client #${id}`));
    points.set(id, { id, name: String(client.raw.name ?? client.raw.company ?? `Client #${id}`), revenue: 0, collected: 0, invoices: 0, leads: 0, quotations: 0 });
  }
  for (const invoice of scoped(invoices, from, to)) {
    const id = numeric(firstValue(invoice.raw, ['client_id', 'customer_id', 'client']));
    if (!id) continue;
    const point = points.get(id) ?? { id, name: names.get(id) ?? `Client #${id}`, revenue: 0, collected: 0, invoices: 0, leads: 0, quotations: 0 };
    point.revenue += amount(invoice.raw, ['total_amount', 'total', 'grand_total', 'amount', 'value']);
    point.invoices += 1;
    points.set(id, point);
  }
  for (const payment of scoped(payments, from, to)) {
    const id = numeric(firstValue(payment.raw, ['client_id', 'customer_id', 'client']));
    const point = id ? points.get(id) : undefined;
    if (point) point.collected += amount(payment.raw, ['amount', 'paid_amount', 'payment_amount', 'value']);
  }
  for (const lead of scoped(leads, from, to)) {
    const id = numeric(firstValue(lead.raw, ['client_id', 'customer_id', 'client_id']));
    const point = id ? points.get(id) : undefined;
    if (point) point.leads += 1;
  }
  for (const quotation of scoped(quotations, from, to)) {
    const id = numeric(firstValue(quotation.raw, ['client_id', 'customer_id', 'client']));
    const point = id ? points.get(id) : undefined;
    if (point) point.quotations += 1;
  }
  return [...points.values()].filter((point) => point.revenue > 0 || point.collected > 0 || point.leads > 0 || point.quotations > 0);
}

function segmentClients(points: ClientPoint[]): CeoAiInsights['clientSegments'] {
  if (!points.length) return [{ name: 'No segment', count: 0, definition: 'No account activity was available for clustering.' }];
  const maxRevenue = Math.max(...points.map((point) => point.revenue), 1);
  const maxActivity = Math.max(...points.map((point) => point.invoices + point.leads + point.quotations), 1);
  const normalized = points.map((point) => [point.revenue / maxRevenue, point.revenue > 0 ? point.collected / point.revenue : 0, (point.invoices + point.leads + point.quotations) / maxActivity]);
  const k = Math.min(3, normalized.length);
  const centers = Array.from({ length: k }, (_, index) => [...normalized[Math.floor((index * normalized.length) / k)]]);
  let assignments = new Array(normalized.length).fill(0) as number[];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    assignments = normalized.map((point) => nearestCenter(point, centers));
    for (let centerIndex = 0; centerIndex < k; centerIndex += 1) {
      const members = normalized.filter((_point, pointIndex) => assignments[pointIndex] === centerIndex);
      if (members.length) centers[centerIndex] = members[0].map((_value, dimension) => members.reduce((sum, member) => sum + member[dimension], 0) / members.length);
    }
  }
  const clusters = centers.map((center, index) => ({ index, center, count: assignments.filter((assignment) => assignment === index).length })).sort((a, b) => b.center[0] - a.center[0]);
  const names = ['Strategic accounts', 'Growth accounts', 'Emerging / watch accounts'];
  const definitions = ['Highest value and activity cluster; protect relationships and renewal quality.', 'Active commercial cluster with room to grow conversion or collections.', 'Smaller, newer or lower-signal cluster requiring qualification and focused follow-up.'];
  return clusters.map((cluster, index) => ({ name: names[index], count: cluster.count, definition: definitions[index] }));
}

function segmentForClient(point: ClientPoint, points: ClientPoint[]): string {
  if (!points.length) return 'Unclassified';
  const sorted = [...points].sort((a, b) => b.revenue - a.revenue);
  const rank = sorted.findIndex((candidate) => candidate.id === point.id);
  if (rank >= 0 && rank < Math.max(1, Math.ceil(sorted.length * 0.2))) return 'Strategic accounts';
  if (point.leads + point.quotations > 0) return 'Growth accounts';
  return 'Emerging / watch accounts';
}

function buildRecommendations(input: { overdueInvoices: number; delayedProjects: number; delayedTasks: number; attendanceRate: number; overtimeMinutes: number; activeUsers: number; expenseValue: number; invoiceValue: number; forecasts: CeoAiInsights['forecasts']; sortedAnomalies: CeoAiInsights['anomalies'] }): CeoAiInsights['recommendations'] {
  const recommendations: CeoAiInsights['recommendations'] = [];
  if (input.overdueInvoices > 0) recommendations.push({ id: 'rec-collections', priority: 'now', title: 'Start a collections sprint', reason: `${input.overdueInvoices} overdue invoice${input.overdueInvoices === 1 ? '' : 's'} are visible in the selected period.`, expectedImpact: 'Reduce receivables exposure and improve cash predictability.', confidence: 92, requiresApproval: false, href: '/invoices' });
  if (input.delayedProjects + input.delayedTasks > 0) recommendations.push({ id: 'rec-delivery', priority: 'now', title: 'Run a delivery recovery review', reason: `${input.delayedProjects} delayed project${input.delayedProjects === 1 ? '' : 's'} and ${input.delayedTasks} late task${input.delayedTasks === 1 ? '' : 's'} need accountable owners.`, expectedImpact: 'Protect client commitments and surface blocked work earlier.', confidence: 89, requiresApproval: false, href: '/projects' });
  if (input.activeUsers > 0 && (input.attendanceRate < 80 || input.overtimeMinutes > input.activeUsers * 240)) recommendations.push({ id: 'rec-workforce', priority: 'soon', title: 'Review workforce capacity', reason: `${Math.round(input.attendanceRate)}% latest attendance and ${Math.round(input.overtimeMinutes)} overtime minutes indicate a capacity signal.`, expectedImpact: 'Rebalance workload and reduce avoidable overtime pressure.', confidence: 84, requiresApproval: false, href: '/workforce' });
  if (input.invoiceValue > 0 && input.expenseValue / input.invoiceValue > 0.65) recommendations.push({ id: 'rec-cost', priority: 'soon', title: 'Review cost intensity', reason: `Recorded expenses are ${Math.round((input.expenseValue / input.invoiceValue) * 100)}% of invoice value in the selected period.`, expectedImpact: 'Protect operating margin before approving additional spend.', confidence: 78, requiresApproval: true, href: '/ceo/approvals' });
  const revenueForecast = input.forecasts.find((forecast) => forecast.id === 'revenue');
  if (revenueForecast?.trend === 'down') recommendations.push({ id: 'rec-forecast', priority: 'watch', title: 'Protect the revenue pipeline', reason: `The revenue baseline is trending down with ${revenueForecast.confidence}% model confidence.`, expectedImpact: 'Focus leadership attention on pipeline conversion and account retention.', confidence: revenueForecast.confidence, requiresApproval: false, href: '/data/leads' });
  if (input.sortedAnomalies.length > 0) recommendations.push({ id: 'rec-anomalies', priority: 'watch', title: 'Review detected anomalies', reason: `${input.sortedAnomalies.length} unusual signal${input.sortedAnomalies.length === 1 ? '' : 's'} departed from recent baselines.`, expectedImpact: 'Separate genuine business events from data-entry or process problems.', confidence: 76, requiresApproval: false, href: '/ceo/audit' });
  if (!recommendations.length) recommendations.push({ id: 'rec-cadence', priority: 'watch', title: 'Keep the executive cadence', reason: 'No high-priority exception crossed the current signal thresholds.', expectedImpact: 'Maintain visibility through the daily brief, portfolio review and approval queue.', confidence: 70, requiresApproval: false, href: '/ceo-dashboard' });
  return recommendations;
}

function buildDeepLearningReadiness(input: { observations: number; populatedSources: number; totalSources: number; activeDays: number; lookbackDays: number }): CeoAiInsights['deepLearningReadiness'] {
  const score = Math.min(100, Math.round((Math.min(1, input.observations / 2_000) * 45) + (input.populatedSources / input.totalSources) * 25 + (Math.min(1, input.activeDays / Math.min(input.lookbackDays, LOOKBACK_DAYS)) * 30)));
  if (score >= 70) return { score, label: 'Pilot ready', currentMode: 'Explainable local models are live; sequence-model pilot is possible after review.', blockers: ['No approved deep-learning model is deployed in production.', 'Labels and outcome definitions must be approved before training.'], nextSteps: ['Define business outcomes and prediction windows.', 'Create a versioned feature snapshot and holdout period.', 'Run offline evaluation, bias checks and CEO-approved pilot monitoring.'] };
  if (score >= 45) return { score, label: 'Data collection in progress', currentMode: 'Use explainable forecasts, anomaly detection and risk scores while longitudinal coverage grows.', blockers: ['More consistent date, status and outcome histories are needed.', 'Deep models would be underpowered with the current sequence coverage.'], nextSteps: ['Improve event timestamps and outcome labels.', 'Keep records consistently linked to clients, projects and employees.', 'Review data quality score each reporting period.'] };
  return { score, label: 'Not ready yet', currentMode: 'Fallback analytics only: transparent formulas remain available without a black-box model.', blockers: ['Insufficient longitudinal observations or populated sources.', 'A deep-learning model would not be reliable with the current evidence.'], nextSteps: ['Complete source mapping and historical backfill.', 'Define labels, retention and access boundaries.', 'Reassess readiness after a stable operating history is recorded.'] };
}

function riskScore(id: string, domain: string, score: number, drivers: string[], href: string): CeoAiInsights['riskScores'][number] {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return { id, domain, score: bounded, label: bounded >= 75 ? 'Critical' : bounded >= 50 ? 'Watch' : 'Controlled', drivers, href };
}

function scoreFinanceRisk(input: { overdueInvoices: number; invoiceCount: number; expenseValue: number; invoiceValue: number; collectedValue: number; anomalies: CeoAiInsights['anomalies'] }): number {
  const overduePressure = Math.min(45, (input.overdueInvoices / Math.max(1, input.invoiceCount)) * 100);
  const costPressure = input.invoiceValue > 0 ? Math.min(35, (input.expenseValue / input.invoiceValue) * 35) : 15;
  const collectionPressure = input.invoiceValue > 0 ? Math.max(0, 20 - (input.collectedValue / input.invoiceValue) * 20) : 10;
  const anomalyPressure = Math.min(15, input.anomalies.filter((anomaly) => anomaly.domain === 'Finance').length * 5);
  return overduePressure + costPressure + collectionPressure + anomalyPressure;
}

function scoreDeliveryRisk(input: { delayedProjects: number; highRiskProjects: number; activeProjects: number; delayedTasks: number }): number {
  return Math.min(100, (input.delayedProjects / Math.max(1, input.activeProjects)) * 50 + Math.min(30, input.highRiskProjects * 10) + Math.min(30, input.delayedTasks * 3));
}

function scorePeopleRisk(input: { attendanceRate: number; overtimeMinutes: number; activeEmployees: number }): number {
  const attendancePressure = Math.max(0, 80 - input.attendanceRate) * 1.2;
  const overtimePressure = Math.min(45, (input.overtimeMinutes / Math.max(1, input.activeEmployees)) / 8);
  return Math.min(100, attendancePressure + overtimePressure);
}

function linearRegression(values: number[]): { slope: number; intercept: number; rSquared: number } {
  if (values.length < 2) return { slope: 0, intercept: values[0] ?? 0, rSquared: 0 };
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  const total = values.reduce((sum, value) => sum + ((value - meanY) ** 2), 0);
  const residual = values.reduce((sum, value, index) => sum + ((value - (intercept + slope * index)) ** 2), 0);
  return { slope, intercept, rSquared: total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : 0 };
}

function sumRange(start: number, end: number, mapper: (value: number) => number): number {
  let total = 0;
  for (let index = start; index <= end; index += 1) total += mapper(index);
  return total;
}

function nearestCenter(point: number[], centers: number[][]): number {
  return centers.reduce((best, center, index) => distance(point, center) < distance(point, centers[best]) ? index : best, 0);
}

function distance(first: number[], second: number[]): number {
  return Math.sqrt(first.reduce((sum, value, index) => sum + ((value - second[index]) ** 2), 0));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function recordDate(record: LegacyRecord): Date | null {
  const value = firstValue(record.raw, ['issue_date', 'invoice_date', 'payment_date', 'expense_date', 'date', 'created_at', 'updated_at', 'due_date', 'deadline', 'end_date']);
  const parsed = parseDate(value);
  return parsed ?? (record.createdAt instanceof Date ? record.createdAt : parseDate(record.createdAt));
}

function latestDay(records: LegacyRecord[]): string | null {
  return records.reduce<string | null>((latest, record) => {
    const current = recordDate(record);
    if (!current) return latest;
    const key = dayKey(current);
    return !latest || key > latest ? key : latest;
  }, null);
}

function isOverdueInvoice(record: LegacyRecord, to: Date): boolean {
  const status = normalizeStatus(record.raw.status);
  const due = parseDate(firstValue(record.raw, ['due_date', 'payment_due_date', 'deadline']));
  return Boolean(due && due.valueOf() < to.valueOf() && !['paid', 'cancelled', 'canceled', 'completed'].includes(status));
}

function isDelayedProject(record: LegacyRecord, to: Date): boolean {
  const status = normalizeStatus(record.raw.status);
  const due = parseDate(firstValue(record.raw, ['due_date', 'deadline', 'end_date', 'completion_date']));
  return Boolean(due && due.valueOf() < to.valueOf() && !['completed', 'closed', 'cancelled', 'canceled'].includes(status));
}

function isHighRiskProject(record: LegacyRecord): boolean {
  return /high|critical|red|at.?risk|blocked|urgent/i.test(String(record.raw.risk_level ?? record.raw.risk ?? record.raw.health ?? record.raw.priority ?? ''));
}

function isActive(status: unknown): boolean {
  return !['inactive', 'resigned', 'terminated', 'deleted'].includes(normalizeStatus(status));
}

function isBefore(date: Date | null, boundary: Date): boolean {
  return Boolean(date && date.valueOf() < boundary.valueOf());
}

function firstValue(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') return raw[key];
  return undefined;
}

function amount(raw: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function startOfDay(value: Date): Date {
  const result = new Date(value.valueOf());
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(value: Date): Date {
  const result = new Date(value.valueOf());
  result.setHours(23, 59, 59, 999);
  return result;
}

function dayKey(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatAmount(value: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

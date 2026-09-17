import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { type LegacyRecord, toPublicRecord } from '../db/legacy.js';
import { requireAuth } from '../middleware/auth.js';
import { emitRealtime } from '../realtime.js';
import { can, isAdminOrHrRole, isCeoRole, type AuthContext } from '../services/permissions.js';
import {
  archiveLegacyRecord,
  createLegacyRecord,
  findLegacyRecord,
  listLegacyRecords,
  listRawRecords,
  updateLegacyRecord
} from '../services/legacyRepository.js';
import { toPublicRecordsWithRelations } from '../services/relationLabels.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { clearGoogleOAuthConfig, readGoogleOAuthConfigStatus, saveGoogleOAuthConfig } from '../services/googleMeet.js';
import { buildCeoAiInsights } from '../services/ceoAiInsights.js';

const approvalActions = ['approve', 'reject', 'return', 'clarify', 'delegate'] as const;
const approvalStatuses = ['pending', 'approved', 'rejected', 'returned', 'clarification_requested', 'delegated'] as const;

const approvalCreateSchema = z.object({
  type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(10_000).optional().nullable(),
  amount: z.coerce.number().finite().nonnegative().optional().nullable(),
  requested_by: z.coerce.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
});

const approvalActionSchema = z.object({
  action: z.enum(approvalActions),
  reason: z.string().trim().max(5_000).optional().nullable(),
  delegated_to: z.coerce.number().int().positive().optional().nullable(),
  comment: z.string().trim().max(5_000).optional().nullable()
}).superRefine((value, context) => {
  if (['reject', 'return', 'delegate'].includes(value.action) && !value.reason?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'A reason is required for this approval action.' });
  }
  if (value.action === 'delegate' && !value.delegated_to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['delegated_to'], message: 'Choose the user who will receive this approval.' });
  }
});

const ceoSettingsSchema = z.object({
  expenseApprovalAbove: z.coerce.number().finite().min(0).max(100_000_000).optional(),
  discountApprovalAbove: z.coerce.number().finite().min(0).max(100).optional(),
  salaryIncrementApprovalAbove: z.coerce.number().finite().min(0).max(100).optional(),
  departmentHeadApprovalLimit: z.coerce.number().finite().min(0).max(100_000_000).optional(),
  projectBudgetOverrunApproval: z.coerce.boolean().optional(),
  invoiceCancellationApproval: z.coerce.boolean().optional(),
  highPriorityHiringApproval: z.coerce.boolean().optional(),
  financialYear: z.string().trim().regex(/^\d{4}[-/]\d{2,4}$/, 'Use a financial year such as 2026-27.').optional(),
  defaultReportFormat: z.enum(['pdf', 'xlsx', 'csv']).optional(),
  dashboardWidgets: z.array(z.string().trim().min(1).max(80)).max(40).optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one CEO setting change.');

const noteCreateSchema = z.object({
  title: z.string().trim().min(1).max(220),
  body: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  confidential: z.boolean().optional()
});
const googleOAuthConfigSchema = z.object({
  clientId: z.string().trim().min(8, 'Enter the Google OAuth client ID.').max(500),
  clientSecret: z.string().trim().max(2_000).optional().nullable(),
  redirectUri: z.string().trim().url('Enter a valid Google OAuth redirect URI.').max(2_000),
  projectId: z.string().trim().max(200).optional().nullable()
});
const notePatchSchema = noteCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one note change.');

const defaults = {
  expenseApprovalAbove: 50_000,
  discountApprovalAbove: 15,
  salaryIncrementApprovalAbove: 10,
  departmentHeadApprovalLimit: 50_000,
  projectBudgetOverrunApproval: true,
  invoiceCancellationApproval: true,
  highPriorityHiringApproval: true,
  financialYear: '2026-27',
  defaultReportFormat: 'pdf' as const,
  dashboardWidgets: ['financial', 'projects', 'departments', 'workforce', 'approvals', 'clients', 'payroll', 'agenda']
};

export const ceoRouter = Router();
ceoRouter.use(requireAuth);

ceoRouter.get('/summary', requireCeoAccess, asyncHandler(async (req, res) => {
  const filters = readSummaryFilters(req.query);
  const data = await buildExecutiveSummary(filters);
  res.json(data);
}));

ceoRouter.get('/ai-insights', requireCeoAccess, asyncHandler(async (req, res) => {
  const data = await buildCeoAiInsights({ from: stringQuery(req.query.from), to: stringQuery(req.query.to) });
  res.json(data);
}));

ceoRouter.get('/approvals', requireCeoAccess, asyncHandler(async (req, res) => {
  const status = stringQuery(req.query.status);
  const filters = status && approvalStatuses.includes(status as typeof approvalStatuses[number]) ? { status } : undefined;
  const result = await listLegacyRecords('ceo_approvals', {
    page: numberQuery(req.query.page, 1),
    limit: Math.min(50, numberQuery(req.query.limit, 10)),
    search: stringQuery(req.query.search),
    searchFields: ['title', 'description', 'type', 'status'],
    filters,
    sort: 'created_at',
    order: 'desc'
  });
  res.json(result);
}));

ceoRouter.post('/approvals', requireApprovalRequestAccess, asyncHandler(async (req, res) => {
  const input = approvalCreateSchema.parse(req.body);
  const createdAt = nowIst();
  const approval = await createLegacyRecord('ceo_approvals', {
    type: input.type,
    title: input.title,
    description: input.description ?? '',
    amount: input.amount ?? null,
    requested_by: input.requested_by ?? req.auth!.legacyId,
    status: 'pending',
    payload: input.payload ?? {},
    approval_history: [],
    created_at: createdAt,
    updated_at: createdAt
  });
  await writeCeoAudit(req.auth!, 'approval.created', 'ceo_approvals', approval.legacyId, null, approval.raw, 'Approval request created.');
  emitRealtime('ceo:approval', { approval: toPublicRecord(approval), action: 'created' }, 'ceo');
  res.status(201).json({ data: toPublicRecord(approval) });
}));

ceoRouter.patch('/approvals/:approvalId', requireCeoAccess, asyncHandler(async (req, res) => {
  const approvalId = positiveId(req.params.approvalId, 'approval');
  const approval = await findLegacyRecord('ceo_approvals', approvalId);
  if (!approval) throw new HttpError(404, 'Approval request not found.');
  const input = approvalActionSchema.parse(req.body);
  const history = Array.isArray(approval.raw.approval_history) ? [...approval.raw.approval_history] : [];
  const status = statusForApprovalAction(input.action);
  const reason = input.reason?.trim() || input.comment?.trim() || null;
  const event = {
    action: input.action,
    by: req.auth!.legacyId,
    by_name: req.auth!.name,
    reason,
    delegated_to: input.delegated_to ?? null,
    at: nowIst()
  };
  history.push(event);
  const updated = await updateLegacyRecord('ceo_approvals', approvalId, {
    status,
    decision: input.action,
    decision_reason: reason,
    executive_comment: input.comment?.trim() || null,
    delegated_to: input.delegated_to ?? null,
    decided_by: req.auth!.legacyId,
    decided_at: nowIst(),
    approval_history: history,
    updated_at: nowIst()
  });
  if (!updated) throw new HttpError(404, 'Approval request not found.');
  await writeCeoAudit(req.auth!, `approval.${input.action}`, 'ceo_approvals', approvalId, approval.raw, updated.raw, reason);
  await notifyApprovalRequester(updated, req.auth!, input.action, reason);
  emitRealtime('ceo:approval', { approval: toPublicRecord(updated), action: input.action }, 'ceo');
  res.json({ data: toPublicRecord(updated) });
}));

ceoRouter.get('/settings', requireCeoAccess, asyncHandler(async (_req, res) => {
  const [record] = await listRawRecords('ceo_approval_rules', { 'raw.key': 'default' }, 1);
  res.json({ data: normalizeSettings(record?.raw) });
}));

ceoRouter.patch('/settings', requireCeoAccess, asyncHandler(async (req, res) => {
  const input = ceoSettingsSchema.parse(req.body);
  const [record] = await listRawRecords('ceo_approval_rules', { 'raw.key': 'default' }, 1);
  const current = normalizeSettings(record?.raw);
  const next = normalizeSettings({
    ...current,
    ...input,
    updated_by: req.auth!.legacyId,
    updated_at: nowIst()
  });
  if (record?.legacyId) {
    await updateLegacyRecord('ceo_approval_rules', record.legacyId, { ...next, key: 'default' });
  } else {
    await createLegacyRecord('ceo_approval_rules', { ...next, key: 'default', created_by: req.auth!.legacyId, created_at: nowIst() });
  }
  await writeCeoAudit(req.auth!, 'settings.updated', 'ceo_approval_rules', record?.legacyId ?? null, current, next, 'CEO approval and executive settings updated.');
  res.json({ data: next });
}));

ceoRouter.get('/google-oauth', requireCeoAccess, asyncHandler(async (_req, res) => {
  res.json({ data: await readGoogleOAuthConfigStatus() });
}));

ceoRouter.put('/google-oauth', requireCeoAccess, asyncHandler(async (req, res) => {
  const input = googleOAuthConfigSchema.parse(req.body);
  const data = await saveGoogleOAuthConfig({ ...input, updatedBy: req.auth!.legacyId });
  await writeCeoAudit(req.auth!, 'google_oauth.updated', 'app_settings', null, null, { ...data, clientSecret: '[stored securely]' }, 'Google OAuth client configuration updated.');
  res.json({ data });
}));

ceoRouter.delete('/google-oauth', requireCeoAccess, asyncHandler(async (req, res) => {
  const data = await clearGoogleOAuthConfig(req.auth!.legacyId);
  await writeCeoAudit(req.auth!, 'google_oauth.cleared', 'app_settings', null, null, data, 'Google OAuth client configuration cleared.');
  res.json({ data });
}));

ceoRouter.get('/audit', requireCeoAccess, asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('ceo_audit_logs', {
    page: numberQuery(req.query.page, 1),
    limit: Math.min(100, numberQuery(req.query.limit, 25)),
    search: stringQuery(req.query.search),
    searchFields: ['action', 'collection', 'reason', 'actor_name'],
    sort: 'created_at',
    order: 'desc'
  });
  res.json(result);
}));

// A dependency-free export endpoint keeps the executive snapshot usable in
// spreadsheet/report workflows without exposing a secret-bearing generic
// export. CSV is intentionally flat and contains only the selected summary
// period; JSON is useful for an authorised BI client.
ceoRouter.get('/reports/summary', requireCeoAccess, asyncHandler(async (req, res) => {
  const summary = await buildExecutiveSummary(readSummaryFilters(req.query));
  const format = String(req.query.format ?? 'json').trim().toLowerCase();
  if (format === 'csv') {
    const rows: Array<[string, string | number]> = [
      ['Metric', 'Value'],
      ['Period', summary.period.today],
      ['Revenue', summary.financial.revenue],
      ['Expenses', summary.financial.expenses],
      ['Profit', summary.financial.profit],
      ['Receivables', summary.financial.receivables],
      ['Cash flow', summary.financial.cashFlow],
      ['Paid invoices', summary.financial.paidInvoices],
      ['Partial invoices', summary.financial.partialInvoices],
      ['Unpaid invoices', summary.financial.unpaidInvoices],
      ['Overdue invoices', summary.financial.overdueInvoices],
      ['Active projects', summary.projects.active],
      ['Delayed projects', summary.projects.delayed],
      ['High-risk projects', summary.projects.highRisk],
      ['Active employees', summary.workforce.activeEmployees],
      ['Attendance rate', summary.workforce.attendanceRate],
      ['Overtime minutes', summary.workforce.overtimeMinutes],
      ['Payroll total', summary.workforce.payrollTotal],
      ['Pending approvals', summary.approvals.pending]
    ];
    res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="ceo-executive-summary.csv"').send(rows.map((row) => row.map(csvCell).join(',')).join('\n'));
    return;
  }
  res.json({ data: summary });
}));

ceoRouter.get('/workspace/notes', requireCeoAccess, asyncHandler(async (req, res) => {
  const result = await listLegacyRecords('ceo_notes', {
    page: numberQuery(req.query.page, 1),
    limit: Math.min(50, numberQuery(req.query.limit, 20)),
    search: stringQuery(req.query.search),
    searchFields: ['title', 'body'],
    sort: 'updated_at',
    order: 'desc'
  });
  res.json(result);
}));

ceoRouter.post('/workspace/notes', requireCeoAccess, asyncHandler(async (req, res) => {
  const input = noteCreateSchema.parse(req.body);
  const createdAt = nowIst();
  const note = await createLegacyRecord('ceo_notes', {
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    confidential: input.confidential ?? true,
    owner_id: req.auth!.legacyId,
    created_by: req.auth!.legacyId,
    created_at: createdAt,
    updated_at: createdAt
  });
  await writeCeoAudit(req.auth!, 'workspace.note.created', 'ceo_notes', note.legacyId, null, note.raw, 'Private CEO note created.');
  res.status(201).json({ data: toPublicRecord(note) });
}));

ceoRouter.patch('/workspace/notes/:noteId', requireCeoAccess, asyncHandler(async (req, res) => {
  const noteId = positiveId(req.params.noteId, 'note');
  const existing = await findLegacyRecord('ceo_notes', noteId);
  if (!existing) throw new HttpError(404, 'Executive note not found.');
  const input = notePatchSchema.parse(req.body);
  const updated = await updateLegacyRecord('ceo_notes', noteId, { ...input, updated_at: nowIst(), updated_by: req.auth!.legacyId });
  if (!updated) throw new HttpError(404, 'Executive note not found.');
  await writeCeoAudit(req.auth!, 'workspace.note.updated', 'ceo_notes', noteId, existing.raw, updated.raw, 'Private CEO note updated.');
  res.json({ data: toPublicRecord(updated) });
}));

ceoRouter.delete('/workspace/notes/:noteId', requireCeoAccess, asyncHandler(async (req, res) => {
  const noteId = positiveId(req.params.noteId, 'note');
  const existing = await findLegacyRecord('ceo_notes', noteId);
  if (!existing) throw new HttpError(404, 'Executive note not found.');
  const archived = await archiveLegacyRecord('ceo_notes', noteId);
  if (!archived) throw new HttpError(404, 'Executive note not found.');
  await writeCeoAudit(req.auth!, 'workspace.note.archived', 'ceo_notes', noteId, existing.raw, null, 'Private CEO note archived.');
  res.status(204).send();
}));

ceoRouter.get('/command-search', requireCeoAccess, asyncHandler(async (req, res) => {
  const query = stringQuery(req.query.q);
  if (!query || query.length < 2) {
    res.json({ data: [] });
    return;
  }
  const expression = query.toLowerCase();
  const [users, projects, tasks, invoices, clients, departments] = await Promise.all([
    listRawRecords('users', {}, 10_000),
    listRawRecords('department_projects', {}, 10_000),
    listRawRecords('tasks', {}, 20_000),
    listRawRecords('invoices', {}, 20_000),
    listRawRecords('clients', {}, 10_000),
    listRawRecords('departments', {}, 5_000)
  ]);
  const data = [
    ...searchResults(users, expression, ['name', 'email', 'designation'], 'Employee', (id) => `/data/users/${id}`),
    ...searchResults(projects, expression, ['name', 'description', 'status'], 'Project', (id) => `/projects/${id}`),
    ...searchResults(tasks, expression, ['title', 'description', 'status'], 'Task', (id) => `/tasks/${id}`),
    ...searchResults(invoices, expression, ['invoice_no', 'title', 'client_name', 'status'], 'Invoice', (id) => `/invoices/${id}`),
    ...searchResults(clients, expression, ['name', 'email', 'phone'], 'Client', (id) => `/data/clients/${id}`),
    ...searchResults(departments, expression, ['name', 'description'], 'Department', (id) => `/data/departments/${id}`)
  ].slice(0, 40);
  res.json({ data });
}));

function requireCeoAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!isCeoRole(req.auth) && !req.auth.permissions.includes('ceo.dashboard')) {
    res.status(403).json({ error: 'Only the CEO can access the executive workspace.' });
    return;
  }
  next();
}

function requireApprovalRequestAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication is required.' });
    return;
  }
  if (!isCeoRole(req.auth) && !isAdminOrHrRole(req.auth) && !can(req.auth, 'ceo.approvals.manage')) {
    res.status(403).json({ error: 'Only the CEO, Admin, HR, or an authorised workflow manager can create approval requests.' });
    return;
  }
  next();
}

interface SummaryFilters {
  company?: string;
  billingProfileId?: number;
  departmentId?: number;
  projectId?: number;
  clientId?: number;
  from?: string;
  to?: string;
}

async function buildExecutiveSummary(filters: SummaryFilters) {
  const [invoices, expenses, projects, departments, users, tasks, attendance, overtime, payroll, clients, leads, quotations, payments, meetings, approvals, activities] = await Promise.all([
    listRawRecords('invoices', {}, 50_000),
    listRawRecords('expenses', {}, 30_000),
    listRawRecords('department_projects', {}, 20_000),
    listRawRecords('departments', {}, 10_000),
    listRawRecords('users', {}, 20_000),
    listRawRecords('tasks', {}, 50_000),
    listRawRecords('attendance_logs', {}, 50_000),
    listRawRecords('attendance_overtime', {}, 50_000),
    listRawRecords('payroll_monthly', {}, 30_000),
    listRawRecords('clients', {}, 20_000),
    listRawRecords('leads', {}, 20_000),
    listRawRecords('quotations', {}, 20_000),
    listRawRecords('payments', {}, 50_000),
    listRawRecords('meetings', {}, 20_000),
    listRawRecords('ceo_approvals', { 'raw.status': 'pending' }, 10_000),
    listRawRecords('activity_logs', {}, 100)
  ]);
  const scopedInvoices = invoices.filter((record) => matchesSummaryFilters(record, filters));
  const scopedExpenses = expenses.filter((record) => matchesSummaryFilters(record, filters));
  const scopedProjects = projects.filter((record) => matchesSummaryFilters(record, filters));
  const scopedTasks = tasks.filter((record) => matchesSummaryFilters(record, filters));
  const scopedPayments = payments.filter((record) => matchesSummaryFilters(record, filters));
  const today = todayIst();
  const invoiceStats = invoiceMetrics(scopedInvoices, today);
  const expenseTotal = scopedExpenses.reduce((sum, record) => sum + amount(record.raw, ['amount', 'total', 'expense_amount', 'value', 'cost']), 0);
  const revenue = invoiceStats.collected || invoiceStats.invoiced;
  const profit = revenue - expenseTotal;
  const cashFlow = invoiceStats.collected - expenseTotal;
  const currentMonth = monthKey(today);
  const previousMonth = monthShift(currentMonth, -1);
  const currentYear = currentMonth.slice(0, 4);
  const monthlyRevenue = scopedInvoices.filter((record) => dateKey(record) .startsWith(currentMonth)).reduce((sum, record) => sum + collectedAmount(record), 0);
  const previousRevenue = scopedInvoices.filter((record) => dateKey(record).startsWith(previousMonth)).reduce((sum, record) => sum + collectedAmount(record), 0);
  const yearlyRevenue = scopedInvoices.filter((record) => dateKey(record).startsWith(currentYear)).reduce((sum, record) => sum + collectedAmount(record), 0);
  const delayedProjects = scopedProjects.filter((project) => isDelayedProject(project, today));
  const highRiskProjects = scopedProjects.filter((project) => isHighRiskProject(project));
  const openTasks = scopedTasks.filter((task) => normalizeStatus(task.raw.status) !== 'completed');
  const delayedTasks = openTasks.filter((task) => dateOnly(task.raw.due_date) && dateOnly(task.raw.due_date)! < today);
  const activeUsers = users.filter((user) => isActiveUser(user.raw.status));
  const attendanceToday = attendance.filter((record) => dateKey(record) === today);
  const overtimeMinutes = [...overtime, ...attendance].reduce((sum, record) => sum + amount(record.raw, ['overtime_minutes', 'overtime', 'ot_minutes']), 0);
  const payrollTotal = payroll.reduce((sum, record) => sum + amount(record.raw, ['net_pay', 'gross_pay', 'monthly_salary', 'salary']), 0);
  const pendingApprovals = approvals.length;
  const departmentsPerformance = buildDepartmentPerformance(departments, users, scopedProjects, scopedTasks, attendance, overtime);
  const projectPortfolio = scopedProjects.slice(0, 20).map((project) => ({
    id: project.legacyId,
    name: String(project.raw.name ?? project.raw.title ?? `Project #${project.legacyId}`),
    status: normalizeStatus(project.raw.status),
    delayed: isDelayedProject(project, today),
    highRisk: isHighRiskProject(project),
    href: `/projects/${project.legacyId}`
  }));
  const todayTasks = scopedTasks.filter((task) => dateOnly(task.raw.due_date) === today).slice(0, 8).map((task) => ({ id: task.legacyId, title: String(task.raw.title ?? 'Task'), href: `/tasks/${task.legacyId}` }));
  const todayMeetings = meetings.filter((meeting) => dateKey(meeting) === today).slice(0, 8).map((meeting) => ({ id: meeting.legacyId, title: String(meeting.raw.title ?? meeting.raw.name ?? 'Meeting'), href: `/data/meetings/${meeting.legacyId}` }));
  const recentCritical = activities.filter((record) => /critical|urgent|risk|failed|overdue|approval/i.test(`${record.raw.action ?? ''} ${record.raw.event ?? ''} ${record.raw.message ?? ''} ${record.raw.description ?? ''}`)).slice(0, 8).map((record) => ({
    id: record.legacyId,
    title: String(record.raw.action ?? record.raw.event ?? record.raw.message ?? 'Critical activity'),
    detail: String(record.raw.description ?? record.raw.message ?? ''),
    at: record.createdAt.toISOString()
  }));
  const healthScore = scoreHealth({ delayedProjects: delayedProjects.length, overdueInvoices: invoiceStats.overdue, pendingApprovals, attendanceRate: attendanceRate(attendanceToday, activeUsers.length) });
  const cards = [
    card('revenue', 'Revenue', formatCurrency(revenue), '/data/invoices?status=paid', 'indigo', `₹${compactNumber(revenue)} collected/invoiced`),
    card('expenses', 'Expenses', formatCurrency(expenseTotal), '/data/expenses', 'rose', `${scopedExpenses.length} expense records`),
    card('profit', 'Profit', formatCurrency(profit), '/data/invoices', profit >= 0 ? 'emerald' : 'rose', 'Revenue less recorded expenses'),
    card('receivables', 'Receivables', formatCurrency(invoiceStats.receivables), '/data/invoices?status=overdue', 'amber', `${invoiceStats.overdue} overdue invoice${invoiceStats.overdue === 1 ? '' : 's'}`),
    card('cash-flow', 'Cash flow', formatCurrency(cashFlow), '/data/payments', 'blue', 'Collected payments less expenses'),
    card('active-projects', 'Active projects', scopedProjects.filter((project) => normalizeStatus(project.raw.status) === 'active').length, '/data/department_projects?status=active', 'violet', `${delayedProjects.length} delayed`),
    card('tasks', 'Open tasks', openTasks.length, '/tasks', 'blue', `${delayedTasks.length} past due`),
    card('approvals', 'Pending approvals', pendingApprovals, '/ceo/approvals', 'amber', 'Needs executive review'),
    card('employees', 'Active employees', activeUsers.length, '/data/users', 'indigo', `${Math.round(attendanceRate(attendanceToday, activeUsers.length))}% attendance today`),
    card('clients', 'Clients', clients.length, '/data/clients', 'emerald', `${leads.length} leads in pipeline`),
    card('payroll', 'Payroll total', formatCurrency(payrollTotal), '/payroll', 'violet', `${payroll.length} monthly payroll records`),
    card('risk', 'High-risk projects', highRiskProjects.length, '/data/department_projects?risk=high', highRiskProjects.length ? 'rose' : 'emerald', 'Portfolio risk watch')
  ];
  return {
    generatedAt: new Date().toISOString(),
    period: { today, month: currentMonth, year: currentYear, from: filters.from ?? null, to: filters.to ?? null },
    filters,
    cards,
    financial: {
      revenue,
      invoiced: invoiceStats.invoiced,
      collected: invoiceStats.collected,
      expenses: expenseTotal,
      profit,
      receivables: invoiceStats.receivables,
      cashFlow,
      paidInvoices: invoiceStats.paid,
      partialInvoices: invoiceStats.partial,
      unpaidInvoices: invoiceStats.unpaid,
      overdueInvoices: invoiceStats.overdue,
      monthlyGrowth: growthPercent(monthlyRevenue, previousRevenue),
      yearlyRevenue,
      monthlyRevenue,
      previousMonthRevenue: previousRevenue
    },
    projects: { total: scopedProjects.length, active: scopedProjects.filter((project) => normalizeStatus(project.raw.status) === 'active').length, completed: scopedProjects.filter((project) => normalizeStatus(project.raw.status) === 'completed').length, delayed: delayedProjects.length, highRisk: highRiskProjects.length, portfolio: projectPortfolio },
    workforce: { activeEmployees: activeUsers.length, attendanceToday: attendanceToday.length, attendanceRate: attendanceRate(attendanceToday, activeUsers.length), overtimeMinutes, openTasks: openTasks.length, delayedTasks: delayedTasks.length, payrollTotal },
    departmentPerformance: departmentsPerformance,
    crm: { clients: clients.length, leads: leads.length, quotations: quotations.length, invoices: scopedInvoices.length, payments: scopedPayments.length },
    approvals: { pending: pendingApprovals, recent: (await toPublicRecordsWithRelations('ceo_approvals', approvals.slice(0, 6))) },
    agenda: { tasks: todayTasks, meetings: todayMeetings, deadlines: [...todayTasks, ...todayMeetings].length },
    recentCriticalActivities: recentCritical,
    businessHealth: { score: healthScore, label: healthScore >= 80 ? 'Healthy' : healthScore >= 60 ? 'Watch' : 'Needs attention' },
    executiveSummary: makeExecutiveSummary({ today, revenue, expenseTotal, profit, delayedProjects: delayedProjects.length, overdueInvoices: invoiceStats.overdue, pendingApprovals, activeUsers: activeUsers.length, attendance: attendanceRate(attendanceToday, activeUsers.length) }),
    sources: ['invoices', 'payments', 'expenses', 'department_projects', 'tasks', 'users', 'attendance_logs', 'attendance_overtime', 'payroll_monthly', 'ceo_approvals', 'activity_logs']
  };
}

function buildDepartmentPerformance(departments: LegacyRecord[], users: LegacyRecord[], projects: LegacyRecord[], tasks: LegacyRecord[], attendance: LegacyRecord[], overtime: LegacyRecord[]) {
  const userNames = new Map(users.flatMap((user) => user.legacyId ? [[user.legacyId, String(user.raw.name ?? user.raw.email ?? `#${user.legacyId}`)] as const] : []));
  return departments.slice(0, 50).map((department) => {
    const id = numeric(department.legacyId ?? department.raw.id);
    const name = String(department.raw.name ?? department.raw.title ?? `Department #${id ?? '—'}`);
    const departmentUsers = users.filter((user) => numeric(user.raw.department_id) === id || String(user.raw.department ?? '').trim().toLowerCase() === name.toLowerCase());
    const departmentProjects = projects.filter((project) => numeric(project.raw.department_id) === id);
    const departmentTasks = tasks.filter((task) => numeric(task.raw.department_id) === id || departmentProjects.some((project) => numeric(project.legacyId) === numeric(task.raw.project_id)));
    const pendingTasks = departmentTasks.filter((task) => normalizeStatus(task.raw.status) !== 'completed');
    const delayedTasks = pendingTasks.filter((task) => Boolean(dateOnly(task.raw.due_date) && dateOnly(task.raw.due_date)! < todayIst()));
    const departmentAttendance = attendance.filter((record) => departmentUsers.some((user) => numeric(user.legacyId) === numeric(record.raw.user_id)));
    const headId = numeric(department.raw.head_user_id);
    const overtimeMinutes = overtime.filter((record) => departmentUsers.some((user) => numeric(user.legacyId) === numeric(record.raw.user_id))).reduce((sum, record) => sum + amount(record.raw, ['overtime_minutes', 'overtime', 'ot_minutes']), 0);
    const score = Math.max(0, Math.min(100, Math.round((pendingTasks.length ? Math.max(0, 100 - delayedTasks.length * 8) : 100) * .65 + attendanceRate(departmentAttendance, departmentUsers.length) * .35)));
    return { id, name, head: headId ? userNames.get(headId) ?? `#${headId}` : null, employees: departmentUsers.length, activeProjects: departmentProjects.filter((project) => normalizeStatus(project.raw.status) === 'active').length, pendingTasks: pendingTasks.length, delayedTasks: delayedTasks.length, attendanceRate: attendanceRate(departmentAttendance, departmentUsers.length), overtimeMinutes, performanceScore: score, href: id ? `/data/departments/${id}/projects` : '/data/departments' };
  });
}

function invoiceMetrics(records: LegacyRecord[], today: string) {
  let invoiced = 0;
  let collected = 0;
  let receivables = 0;
  let paid = 0;
  let partial = 0;
  let unpaid = 0;
  let overdue = 0;
  for (const record of records) {
    const total = amount(record.raw, ['total_amount', 'grand_total', 'total', 'amount', 'net_total', 'invoice_total']);
    const status = normalizeStatus(record.raw.status ?? record.raw.payment_status);
    const paidAmount = amount(record.raw, ['paid_amount', 'amount_paid', 'received_amount', 'payment_received', 'paid']);
    const effectivePaid = paidAmount > 0 ? paidAmount : ['paid', 'completed', 'settled'].includes(status) ? total : 0;
    invoiced += total;
    collected += effectivePaid;
    receivables += Math.max(0, total - effectivePaid);
    if (['paid', 'completed', 'settled'].includes(status) || (total > 0 && effectivePaid >= total)) paid += 1;
    else if (effectivePaid > 0 || ['partial', 'partially_paid'].includes(status)) partial += 1;
    else unpaid += 1;
    const due = dateOnly(record.raw.due_date ?? record.raw.payment_due_date);
    if (status === 'overdue' || Boolean(due && due < today && !['paid', 'completed', 'settled', 'cancelled'].includes(status))) overdue += 1;
  }
  return { invoiced, collected, receivables, paid, partial, unpaid, overdue };
}

function matchesSummaryFilters(record: LegacyRecord, filters: SummaryFilters): boolean {
  const raw = record.raw;
  if (filters.company && !containsAny(raw, ['company', 'company_name', 'company_id', 'billing_profile_id'], filters.company)) return false;
  if (filters.billingProfileId && !matchesNumeric(raw, ['billing_profile_id', 'billing_profile', 'profile_id'], filters.billingProfileId)) return false;
  if (filters.departmentId && !matchesNumeric(raw, ['department_id'], filters.departmentId)) return false;
  if (filters.projectId && !matchesNumeric(raw, ['project_id'], filters.projectId)) return false;
  if (filters.clientId && !matchesNumeric(raw, ['client_id'], filters.clientId)) return false;
  const key = dateKey(record);
  if (filters.from && key && key < filters.from) return false;
  if (filters.to && key && key > filters.to) return false;
  return true;
}

function readSummaryFilters(query: Record<string, unknown>): SummaryFilters {
  return {
    company: stringQuery(query.company),
    billingProfileId: numeric(query.billingProfileId) ?? undefined,
    departmentId: numeric(query.departmentId) ?? undefined,
    projectId: numeric(query.projectId) ?? undefined,
    clientId: numeric(query.clientId) ?? undefined,
    from: dateOnly(query.from) ?? undefined,
    to: dateOnly(query.to) ?? undefined
  };
}

function normalizeSettings(raw?: Record<string, unknown>) {
  return {
    expenseApprovalAbove: nonNegative(raw?.expenseApprovalAbove ?? raw?.expense_approval_above, defaults.expenseApprovalAbove),
    discountApprovalAbove: nonNegative(raw?.discountApprovalAbove ?? raw?.discount_approval_above, defaults.discountApprovalAbove),
    salaryIncrementApprovalAbove: nonNegative(raw?.salaryIncrementApprovalAbove ?? raw?.salary_increment_approval_above, defaults.salaryIncrementApprovalAbove),
    departmentHeadApprovalLimit: nonNegative(raw?.departmentHeadApprovalLimit ?? raw?.department_head_approval_limit, defaults.departmentHeadApprovalLimit),
    projectBudgetOverrunApproval: bool(raw?.projectBudgetOverrunApproval ?? raw?.project_budget_overrun_approval, defaults.projectBudgetOverrunApproval),
    invoiceCancellationApproval: bool(raw?.invoiceCancellationApproval ?? raw?.invoice_cancellation_approval, defaults.invoiceCancellationApproval),
    highPriorityHiringApproval: bool(raw?.highPriorityHiringApproval ?? raw?.high_priority_hiring_approval, defaults.highPriorityHiringApproval),
    financialYear: String(raw?.financialYear ?? raw?.financial_year ?? defaults.financialYear),
    defaultReportFormat: ['pdf', 'xlsx', 'csv'].includes(String(raw?.defaultReportFormat ?? raw?.default_report_format)) ? String(raw?.defaultReportFormat ?? raw?.default_report_format) : defaults.defaultReportFormat,
    dashboardWidgets: Array.isArray(raw?.dashboardWidgets ?? raw?.dashboard_widgets) ? (raw?.dashboardWidgets ?? raw?.dashboard_widgets) as string[] : defaults.dashboardWidgets
  };
}

async function writeCeoAudit(context: AuthContext, action: string, collection: string, recordId: number | null | undefined, before: unknown, after: unknown, reason: string | null | undefined): Promise<void> {
  await createLegacyRecord('ceo_audit_logs', {
    action,
    collection,
    record_id: recordId ?? null,
    actor_id: context.legacyId,
    actor_name: context.name,
    reason: reason ?? null,
    before,
    after,
    created_at: nowIst()
  });
}

async function notifyApprovalRequester(approval: LegacyRecord, actor: AuthContext, action: string, reason: string | null): Promise<void> {
  const requesterId = numeric(approval.raw.requested_by);
  if (!requesterId || requesterId === actor.legacyId) return;
  const title = `CEO approval ${action}: ${String(approval.raw.title ?? 'request')}`;
  const notification = await createLegacyRecord('notifications', {
    user_id: requesterId,
    title,
    body: `${actor.name} marked your approval request as ${action}.${reason ? ` Reason: ${reason}` : ''}`,
    type: 'ceo.approval',
    priority: 'high',
    url: '/ceo/approvals',
    is_read: 0,
    created_at: nowIst()
  });
  emitRealtime('notification:new', { notification: toPublicRecord(notification) }, `user:${requesterId}`);
}

function searchResults(records: LegacyRecord[], query: string, fields: string[], kind: string, route: (id: number) => string) {
  return records.filter((record) => fields.some((field) => String(record.raw[field] ?? '').toLowerCase().includes(query))).slice(0, 8).flatMap((record) => {
    const id = numeric(record.legacyId ?? record.raw.id);
    if (!id) return [];
    const label = String(record.raw.name ?? record.raw.title ?? record.raw.invoice_no ?? `#${id}`);
    const detail = String(record.raw.email ?? record.raw.status ?? record.raw.description ?? '').trim();
    return [{ id: `${kind.toLowerCase()}-${id}`, kind, label, detail, href: route(id) }];
  });
}

function statusForApprovalAction(action: typeof approvalActions[number]): typeof approvalStatuses[number] {
  if (action === 'approve') return 'approved';
  if (action === 'reject') return 'rejected';
  if (action === 'return') return 'returned';
  if (action === 'clarify') return 'clarification_requested';
  return 'delegated';
}

function card(id: string, label: string, value: string | number, href: string, tone: string, detail: string) {
  return { id, label, value, href, tone, detail };
}

function makeExecutiveSummary(input: { today: string; revenue: number; expenseTotal: number; profit: number; delayedProjects: number; overdueInvoices: number; pendingApprovals: number; activeUsers: number; attendance: number }): string {
  return `Executive snapshot for ${input.today}: ${input.activeUsers} active employees with ${Math.round(input.attendance)}% attendance today. Revenue is ${formatCurrency(input.revenue)}, expenses are ${formatCurrency(input.expenseTotal)}, and recorded profit is ${formatCurrency(input.profit)}. ${input.delayedProjects} project${input.delayedProjects === 1 ? '' : 's'} are delayed, ${input.overdueInvoices} invoice${input.overdueInvoices === 1 ? '' : 's'} are overdue, and ${input.pendingApprovals} approval${input.pendingApprovals === 1 ? '' : 's'} need CEO review. These are CRM facts for the selected period; forecasts and recommendations should be reviewed before action.`;
}

function scoreHealth(input: { delayedProjects: number; overdueInvoices: number; pendingApprovals: number; attendanceRate: number }): number {
  return Math.max(0, Math.min(100, Math.round(100 - input.delayedProjects * 7 - input.overdueInvoices * 3 - input.pendingApprovals * 2 + (input.attendanceRate - 80) * .15)));
}

function attendanceRate(records: LegacyRecord[], employeeCount: number): number {
  if (!employeeCount) return records.length ? 100 : 0;
  const present = records.filter((record) => ['present', 'worked', 'completed', '1', 'active'].includes(normalizeStatus(record.raw.status ?? record.raw.attendance_status))).length;
  return Math.max(0, Math.min(100, (present / employeeCount) * 100));
}

function isDelayedProject(project: LegacyRecord, today: string): boolean {
  const status = normalizeStatus(project.raw.status);
  const due = dateOnly(project.raw.end_date ?? project.raw.due_date ?? project.raw.deadline);
  return !['completed', 'cancelled', 'closed'].includes(status) && Boolean(due && due < today);
}

function isHighRiskProject(project: LegacyRecord): boolean {
  const value = String(project.raw.risk_level ?? project.raw.risk ?? project.raw.health ?? '').toLowerCase();
  return ['high', 'critical', 'red', 'at_risk', 'at-risk'].some((token) => value.includes(token)) || ['blocked', 'on_hold'].includes(normalizeStatus(project.raw.status));
}

function collectedAmount(record: LegacyRecord): number {
  const total = amount(record.raw, ['total_amount', 'grand_total', 'total', 'amount', 'net_total', 'invoice_total']);
  const paid = amount(record.raw, ['paid_amount', 'amount_paid', 'received_amount', 'payment_received', 'paid']);
  return paid > 0 ? paid : ['paid', 'completed', 'settled'].includes(normalizeStatus(record.raw.status ?? record.raw.payment_status)) ? total : 0;
}

function dateKey(record: LegacyRecord): string {
  return dateOnly(record.raw.scheduled_start ?? record.raw.meeting_date ?? record.raw.start_at ?? record.raw.created_at ?? record.raw.invoice_date ?? record.raw.date ?? record.raw.payment_date ?? record.createdAt) ?? '';
}

function monthKey(value: string): string { return value.slice(0, 7); }
function monthShift(value: string, shift: number): string {
  const date = new Date(`${value}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + shift);
  return date.toISOString().slice(0, 7);
}
function growthPercent(current: number, previous: number): number { return previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 1000) / 10; }
function formatCurrency(value: number): string { return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(value))}`; }
function compactNumber(value: number): string { return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(value)); }
function amount(raw: Record<string, unknown>, fields: string[]): number { for (const field of fields) { const value = Number(raw[field]); if (Number.isFinite(value) && value >= 0) return value; } return 0; }
function nonNegative(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function bool(value: unknown, fallback: boolean): boolean { if (value === undefined || value === null || value === '') return fallback; return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()); }
function numeric(value: unknown): number | null { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; }
function matchesNumeric(raw: Record<string, unknown>, fields: string[], value: number): boolean { return fields.some((field) => numeric(raw[field]) === value); }
function containsAny(raw: Record<string, unknown>, fields: string[], value: string): boolean { const query = value.toLowerCase(); return fields.some((field) => String(raw[field] ?? '').toLowerCase().includes(query)); }
function normalizeStatus(value: unknown): string { return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function dateOnly(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}
function isActiveUser(value: unknown): boolean { return value === undefined || value === null || value === '' || ['active', 'enabled', '1', 'true'].includes(String(value).toLowerCase()); }
function positiveId(value: string | string[] | undefined, label: string): number { const parsed = numeric(Array.isArray(value) ? value[0] : value); if (!parsed) throw new HttpError(400, `Invalid ${label} ID.`); return parsed; }
function stringQuery(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function numberQuery(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
function todayIst(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
function nowIst(): string { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date()); }

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

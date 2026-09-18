import type { LucideIcon } from 'lucide-react';
import {
  BadgeIndianRupee,
  BarChart3,
  DatabaseBackup,
  BrainCircuit,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  ClipboardCheck,
  Crown,
  FileText,
  FolderOpen,
  HandCoins,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  Radar,
  MessageCircle,
  Palette,
  ReceiptText,
  Scale,
  ShieldCheck,
  Sparkles,
  ShieldAlert,
  UsersRound,
  UserRoundCog,
  WalletCards
} from 'lucide-react';

export type FieldKind = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean' | 'email' | 'image' | 'relation' | 'multiRelation';
export type RelationCollection = 'users' | 'departments' | 'teams' | 'department_projects' | 'drive_items' | 'folders' | 'recruitment_positions' | 'clients';

export interface FieldDefinition {
  key: string;
  label: string;
  kind?: FieldKind;
  options?: string[];
  relation?: RelationCollection;
  required?: boolean;
}

export interface ResourceConfig {
  id: string;
  label: string;
  singular: string;
  description: string;
  icon: LucideIcon;
  permission?: string;
  fields: FieldDefinition[];
  columns: string[];
  searchFields?: string[];
}

export const resources: ResourceConfig[] = [
  { id: 'calendar_events', label: 'Corporate Calendar', singular: 'Calendar event', description: 'Company holidays, meetings, deadlines, shifts, leave and reminders.', icon: CalendarClock, permission: 'calendar.view', columns: ['title', 'type', 'status', 'start', 'end', 'location'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'start', label: 'Start', kind: 'date' }, { key: 'end', label: 'End', kind: 'date' }, { key: 'description', label: 'Notes', kind: 'textarea' }] },
  {
    id: 'users', label: 'Employees', singular: 'Employee', description: 'Staff accounts, designations, reporting lines and access roles.', icon: UsersRound, permission: 'employees.view',
    columns: ['name', 'email', 'department', 'designation', 'role', 'status'], searchFields: ['name', 'email', 'department', 'designation'],
    fields: [
      { key: 'name', label: 'Full name', required: true }, { key: 'email', label: 'Email', kind: 'email', required: true }, { key: 'phone', label: 'Phone' },
      { key: 'department', label: 'Department' }, { key: 'designation', label: 'Designation' }, { key: 'joining_date', label: 'Joining date', kind: 'date' },
      { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive', 'resigned'] }, { key: 'role', label: 'Role', kind: 'select', options: ['admin', 'ceo', 'hr', 'manager', 'employee', 'remote_staff'] }
    ]
  },
  {
    id: 'departments', label: 'Departments', singular: 'Department', description: 'Organisational units, leads and departmental work.', icon: Building2, permission: 'departments.view',
    columns: ['name', 'slug', 'description', 'head_user_id'], fields: [{ key: 'name', label: 'Name', required: true }, { key: 'slug', label: 'Slug' }, { key: 'icon', label: 'Icon' }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'head_user_id', label: 'Department head', kind: 'relation', relation: 'users' }]
  },
  {
    id: 'teams', label: 'Teams', singular: 'Team', description: 'Cross-functional teams, leaders, member roles and team discussions.', icon: UsersRound, permission: 'teams.view',
    columns: ['name', 'leader_id', 'description'], fields: [{ key: 'name', label: 'Name', required: true }, { key: 'leader_id', label: 'Leader', kind: 'relation', relation: 'users', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }]
  },
  {
    id: 'department_projects', label: 'Projects', singular: 'Project', description: 'Department-owned projects, timelines, status and accountable leads.', icon: BriefcaseBusiness, permission: 'departments.view',
    columns: ['name', 'department_id', 'team_id', 'lead_user_id', 'status', 'start_date', 'end_date'], fields: [
      { key: 'name', label: 'Project name', required: true }, { key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments', required: true }, { key: 'team_id', label: 'Team', kind: 'relation', relation: 'teams' },
      { key: 'lead_user_id', label: 'Lead user', kind: 'relation', relation: 'users' }, { key: 'status', label: 'Status', kind: 'select', options: ['planned', 'active', 'on_hold', 'completed', 'cancelled'] },
      { key: 'start_date', label: 'Start date', kind: 'date' }, { key: 'end_date', label: 'End date', kind: 'date' }, { key: 'description', label: 'Description', kind: 'textarea' }
    ]
  },
  {
    id: 'clients', label: 'Clients', singular: 'Client', description: 'Client profiles, contact details, GST information and commercial notes.', icon: HandCoins, permission: 'clients.view',
    columns: ['name', 'type', 'status', 'email', 'phone', 'city', 'gstin'], fields: [
      { key: 'name', label: 'Client name', required: true }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive', 'lead'] },
      { key: 'email', label: 'Email', kind: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address', kind: 'textarea' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'country', label: 'Country' }, { key: 'gst_registered', label: 'GST registered', kind: 'boolean' }, { key: 'gstin', label: 'GSTIN' }, { key: 'notes', label: 'Notes', kind: 'textarea' }
    ]
  },
  {
    id: 'billing_profiles', label: 'Billing Profiles', singular: 'Billing profile', description: 'Legal entity, GST, bank account, invoice branding and payment QR codes.', icon: Landmark, permission: 'billing.view',
    columns: ['code', 'legal_name', 'logo_file', 'signature_file', 'qr_code_primary_file', 'qr_code_secondary_file', 'qr_code_secondary_enabled', 'phone', 'email', 'gst_default_enabled', 'gstin'], fields: [
      { key: 'code', label: 'Code', required: true }, { key: 'legal_name', label: 'Legal name / business name', required: true }, { key: 'logo_file', label: 'Company logo', kind: 'image' }, { key: 'signature_file', label: 'Authorized signatory signature', kind: 'image' }, { key: 'qr_code_primary_file', label: 'QR Code Primary', kind: 'image' }, { key: 'qr_code_secondary_file', label: 'QR Code Secondary', kind: 'image' }, { key: 'qr_code_secondary_enabled', label: 'Enable QR Code Secondary on invoices and PDFs', kind: 'boolean' },
      { key: 'address', label: 'Business address', kind: 'textarea' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', kind: 'email' }, { key: 'website', label: 'Website' },
      { key: 'gst_default_enabled', label: 'GST enabled', kind: 'boolean' }, { key: 'gstin', label: 'GSTIN' }, { key: 'bank_name', label: 'Bank name' }, { key: 'bank_account_number', label: 'Account number' }, { key: 'bank_ifsc_code', label: 'IFSC code' }
    ]
  },
  {
    id: 'maintenance_contracts', label: 'Maintenance Contracts', singular: 'Maintenance contract', description: 'Recurring client services, billing cycles and generated invoices.', icon: ReceiptText, permission: 'billing.view',
    columns: ['client_id', 'title', 'status', 'start_date', 'end_date', 'monthly_fee', 'next_invoice_date'], fields: [
      { key: 'client_id', label: 'Client', kind: 'relation', relation: 'clients', required: true }, { key: 'title', label: 'Title', required: true }, { key: 'status', label: 'Status', kind: 'select', options: ['active', 'paused', 'completed', 'cancelled'] }, { key: 'start_date', label: 'Start date', kind: 'date' }, { key: 'end_date', label: 'End date', kind: 'date' }, { key: 'monthly_fee', label: 'Monthly fee', kind: 'number' }, { key: 'billing_day', label: 'Billing day', kind: 'number' }, { key: 'notes', label: 'Notes', kind: 'textarea' }
    ]
  },
  {
    id: 'leave_requests', label: 'Leave Requests', singular: 'Leave request', description: 'Leave history, approvals, proof files and audit notes.', icon: CalendarClock, permission: 'leave.view',
    columns: ['user_id', 'leave_type', 'start_date', 'end_date', 'days_count', 'status'], fields: [
      { key: 'user_id', label: 'User ID', kind: 'number', required: true }, { key: 'leave_type', label: 'Leave type', required: true }, { key: 'start_date', label: 'Start date', kind: 'date', required: true }, { key: 'end_date', label: 'End date', kind: 'date', required: true }, { key: 'reason', label: 'Reason', kind: 'textarea' }, { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'approved', 'rejected', 'cancelled'] }
    ]
  },
  {
    id: 'payroll_runs', label: 'Payroll Runs', singular: 'Payroll run', description: 'Monthly payroll runs, periods, calculations and approval history.', icon: WalletCards, permission: 'payroll.view',
    columns: ['run_no', 'month', 'year', 'period_from', 'period_to', 'status'], fields: [{ key: 'month', label: 'Month', kind: 'number', required: true }, { key: 'year', label: 'Year', kind: 'number', required: true }, { key: 'period_from', label: 'Period from', kind: 'date' }, { key: 'period_to', label: 'Period to', kind: 'date' }, { key: 'status', label: 'Status' }, { key: 'notes', label: 'Notes', kind: 'textarea' }]
  },
  {
    id: 'payroll_monthly', label: 'Monthly Payroll', singular: 'Payroll record', description: 'Employee salary calculation, attendance inputs, deductions and payment status.', icon: WalletCards, permission: 'payroll.view',
    columns: ['user_id', 'period_month', 'present_days', 'leave_days', 'gross_pay', 'net_pay', 'salary_status'], fields: [{ key: 'user_id', label: 'User ID', kind: 'number', required: true }, { key: 'period_month', label: 'Period month' }, { key: 'monthly_salary', label: 'Monthly salary', kind: 'number' }, { key: 'gross_pay', label: 'Gross pay', kind: 'number' }, { key: 'net_pay', label: 'Net pay', kind: 'number' }, { key: 'salary_status', label: 'Status' }]
  },
  {
    id: 'salary_structures', label: 'Salary Structures', singular: 'Salary structure', description: 'Effective salary structures including base, allowances, incentives and deductions.', icon: BadgeIndianRupee, permission: 'salary.view',
    columns: ['user_id', 'effective_from', 'base_salary', 'allowances', 'incentives', 'deductions'], fields: [{ key: 'user_id', label: 'User ID', kind: 'number', required: true }, { key: 'effective_from', label: 'Effective from', kind: 'date' }, { key: 'base_salary', label: 'Base salary', kind: 'number' }, { key: 'allowances', label: 'Allowances', kind: 'number' }, { key: 'incentives', label: 'Incentives', kind: 'number' }, { key: 'deductions', label: 'Deductions', kind: 'number' }, { key: 'notes', label: 'Notes', kind: 'textarea' }]
  },
  {
    id: 'recruitment_positions', label: 'Open Positions', singular: 'Position', description: 'Hiring positions, requirements, compensation bands and status.', icon: ClipboardList, permission: 'recruitments.view',
    columns: ['title', 'department_id', 'employment_type', 'location', 'status', 'openings'], fields: [{ key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments', required: true }, { key: 'title', label: 'Title', required: true }, { key: 'employment_type', label: 'Employment type' }, { key: 'location', label: 'Location' }, { key: 'status', label: 'Status', kind: 'select', options: ['open', 'paused', 'closed'] }, { key: 'openings', label: 'Openings', kind: 'number' }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'requirements', label: 'Requirements', kind: 'textarea' }]
  },
  {
    id: 'recruitment_applicants', label: 'Applicants', singular: 'Applicant', description: 'Candidate pipeline, stage history, notes and attachments.', icon: UserRoundCog, permission: 'recruitments.applicants.view',
    columns: ['full_name', 'position_id', 'email', 'phone', 'stage', 'status', 'location'], fields: [{ key: 'position_id', label: 'Position', kind: 'relation', relation: 'recruitment_positions', required: true }, { key: 'full_name', label: 'Full name', required: true }, { key: 'email', label: 'Email', kind: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'stage', label: 'Stage' }, { key: 'status', label: 'Status' }, { key: 'experience_years', label: 'Experience (years)', kind: 'number' }, { key: 'notes', label: 'Notes', kind: 'textarea' }]
  },
  {
    id: 'drive_items', label: 'Drive', singular: 'Drive item', description: 'Shared folders and files retained from the original document drive.', icon: FolderOpen, permission: 'drive.view',
    columns: ['name', 'type', 'parent_id', 'mime_type', 'size', 'created_at'], fields: [{ key: 'name', label: 'Name', required: true }, { key: 'type', label: 'Type', kind: 'select', options: ['folder', 'file'] }, { key: 'parent_id', label: 'Parent folder', kind: 'relation', relation: 'drive_items' }, { key: 'mime_type', label: 'MIME type' }, { key: 'size', label: 'Size', kind: 'number' }]
  },
  {
    id: 'roles', label: 'Roles', singular: 'Role', description: 'Role definitions used by the legacy permission matrix.', icon: ShieldCheck, permission: 'rbac.view',
    columns: ['name', 'slug', 'description'], fields: [{ key: 'name', label: 'Name', required: true }, { key: 'slug', label: 'Slug', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }]
  },
  {
    id: 'permissions', label: 'Permissions', singular: 'Permission', description: 'Fine-grained permission definitions and module descriptions.', icon: Scale, permission: 'rbac.view',
    columns: ['code', 'name', 'module', 'description'], fields: [{ key: 'code', label: 'Code', required: true }, { key: 'name', label: 'Name', required: true }, { key: 'module', label: 'Module' }, { key: 'description', label: 'Description', kind: 'textarea' }]
  },
  {
    id: 'announcements', label: 'Announcements', singular: 'Announcement', description: 'Internal announcements and acknowledgement records.', icon: FileText, permission: 'dashboard.view',
    columns: ['title', 'body', 'created_by', 'created_at'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'body', label: 'Body', kind: 'textarea' }]
  },
  {
    id: 'employee_todos', label: 'My Work Notes', singular: 'Work note', description: 'Private dashboard notes owned and managed by the signed-in user.', icon: CheckSquare, permission: 'dashboard.view',
    columns: ['user_id', 'title', 'status', 'start_at', 'end_at'], fields: [{ key: 'user_id', label: 'User ID', kind: 'number', required: true }, { key: 'title', label: 'Title', required: true }, { key: 'notes', label: 'Notes', kind: 'textarea' }, { key: 'status', label: 'Status', kind: 'select', options: ['pending', 'active', 'completed'] }, { key: 'end_at', label: 'Due date', kind: 'date' }]
  },
  {
    id: 'expenses', label: 'Expenses', singular: 'Expense', description: 'Company spending, vendor costs, receipts and approval state.', icon: WalletCards, permission: 'expenses.view',
    columns: ['title', 'category', 'amount', 'department_id', 'status', 'expense_date'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount', kind: 'number' }, { key: 'department_id', label: 'Department', kind: 'relation', relation: 'departments' }, { key: 'status', label: 'Status' }, { key: 'expense_date', label: 'Expense date', kind: 'date' }, { key: 'notes', label: 'Notes', kind: 'textarea' }]
  },
  {
    id: 'leads', label: 'Leads', singular: 'Lead', description: 'Sales pipeline, lead conversion and follow-up intelligence.', icon: Radar, permission: 'leads.view',
    columns: ['name', 'company', 'email', 'stage', 'status', 'value'], fields: [{ key: 'name', label: 'Lead name', required: true }, { key: 'company', label: 'Company' }, { key: 'email', label: 'Email', kind: 'email' }, { key: 'phone', label: 'Phone' }, { key: 'stage', label: 'Stage' }, { key: 'status', label: 'Status' }, { key: 'value', label: 'Pipeline value', kind: 'number' }]
  },
  {
    id: 'quotations', label: 'Quotations', singular: 'Quotation', description: 'Commercial quotations and approval history.', icon: FileText, permission: 'quotations.view',
    columns: ['quotation_no', 'client_id', 'title', 'status', 'total_amount', 'valid_until'], fields: [{ key: 'quotation_no', label: 'Quotation no.' }, { key: 'client_id', label: 'Client', kind: 'relation', relation: 'clients' }, { key: 'title', label: 'Title', required: true }, { key: 'status', label: 'Status' }, { key: 'total_amount', label: 'Total amount', kind: 'number' }, { key: 'valid_until', label: 'Valid until', kind: 'date' }]
  },
  {
    id: 'meetings', label: 'Meetings', singular: 'Meeting', description: 'Internal and client meetings, agendas and action items.', icon: CalendarClock, permission: 'meetings.view',
    columns: ['title', 'meeting_date', 'status', 'organizer_id', 'meeting_link'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'meeting_date', label: 'Meeting date', kind: 'date' }, { key: 'status', label: 'Status' }, { key: 'organizer_id', label: 'Organizer', kind: 'relation', relation: 'users' }, { key: 'meeting_link', label: 'Meeting link' }, { key: 'agenda', label: 'Agenda', kind: 'textarea' }]
  },
  {
    id: 'ceo_approvals', label: 'Approval Centre', singular: 'Approval request', description: 'CEO approvals, decisions, comments and delegated actions.', icon: ClipboardCheck, permission: 'ceo.approvals.view',
    columns: ['type', 'title', 'amount', 'status', 'requested_by', 'created_at'], fields: [{ key: 'type', label: 'Request type' }, { key: 'title', label: 'Title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'amount', label: 'Amount', kind: 'number' }, { key: 'status', label: 'Status' }, { key: 'requested_by', label: 'Requested by', kind: 'number' }]
  },
  {
    id: 'ceo_goals', label: 'Company Goals & OKRs', singular: 'Goal', description: 'Executive goals, owners, key results and check-ins.', icon: Crown, permission: 'ceo.workspace',
    columns: ['title', 'owner_id', 'status', 'progress', 'due_date'], fields: [{ key: 'title', label: 'Goal title', required: true }, { key: 'owner_id', label: 'Owner', kind: 'relation', relation: 'users' }, { key: 'status', label: 'Status' }, { key: 'progress', label: 'Progress', kind: 'number' }, { key: 'due_date', label: 'Due date', kind: 'date' }, { key: 'description', label: 'Description', kind: 'textarea' }]
  },
  {
    id: 'ceo_risks', label: 'Risk Register', singular: 'Risk', description: 'Financial, project, client, workforce and security risks.', icon: ShieldAlert, permission: 'ceo.workspace',
    columns: ['title', 'category', 'severity', 'owner_id', 'status', 'deadline'], fields: [{ key: 'title', label: 'Risk title', required: true }, { key: 'category', label: 'Category' }, { key: 'severity', label: 'Severity' }, { key: 'owner_id', label: 'Owner', kind: 'relation', relation: 'users' }, { key: 'status', label: 'Status' }, { key: 'deadline', label: 'Deadline', kind: 'date' }, { key: 'mitigation_plan', label: 'Mitigation plan', kind: 'textarea' }]
  },
  {
    id: 'ceo_forecasts', label: 'Scenario Forecasts', singular: 'Forecast', description: 'Best, expected and worst-case planning scenarios.', icon: BarChart3, permission: 'ceo.workspace',
    columns: ['title', 'scenario', 'period', 'metric', 'value', 'assumptions'], fields: [{ key: 'title', label: 'Forecast title', required: true }, { key: 'scenario', label: 'Scenario', kind: 'select', options: ['best_case', 'expected_case', 'worst_case'] }, { key: 'period', label: 'Period' }, { key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value', kind: 'number' }, { key: 'assumptions', label: 'Assumptions', kind: 'textarea' }]
  },
  {
    id: 'ceo_notes', label: 'Executive Notes', singular: 'Executive note', description: 'Private notes visible only inside the CEO workspace.', icon: LockKeyhole, permission: 'ceo.workspace',
    columns: ['title', 'tags', 'updated_at'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'body', label: 'Note', kind: 'textarea', required: true }, { key: 'tags', label: 'Tags' }]
  },
  {
    id: 'ceo_delegations', label: 'Delegation & Acting Authority', singular: 'Delegation', description: 'Time-bounded, permission-scoped executive delegations with audit history.', icon: Crown, permission: 'ceo.delegation.view',
    columns: ['delegate_user_id', 'permissions', 'starts_at', 'expires_at', 'approval_limit', 'status'], fields: [{ key: 'delegate_user_id', label: 'Delegate user', kind: 'relation', relation: 'users', required: true }, { key: 'permissions', label: 'Permissions', kind: 'textarea', required: true }, { key: 'starts_at', label: 'Starts at', kind: 'date', required: true }, { key: 'expires_at', label: 'Expires at', kind: 'date', required: true }, { key: 'approval_limit', label: 'Approval limit', kind: 'number' }, { key: 'reason', label: 'Reason', kind: 'textarea', required: true }, { key: 'status', label: 'Status', kind: 'select', options: ['active', 'expired', 'revoked'] }]
  },
  {
    id: 'ceo_announcements', label: 'Company Announcements', singular: 'Announcement', description: 'Executive announcements targeted to the whole company or selected teams.', icon: Crown,
    columns: ['title', 'audience', 'published_at', 'expires_at', 'pinned', 'status'], fields: [{ key: 'title', label: 'Title', required: true }, { key: 'body', label: 'Announcement', kind: 'textarea', required: true }, { key: 'audience', label: 'Audience' }, { key: 'published_at', label: 'Publish date', kind: 'date' }, { key: 'expires_at', label: 'Expiry date', kind: 'date' }, { key: 'pinned', label: 'Pinned', kind: 'boolean' }, { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'published', 'expired'] }]
  }
];

export const resourceById = new Map(resources.map((resource) => [resource.id, resource]));

export interface NavigationItem {
  label: string;
  to: string;
  icon: LucideIcon;
  permission?: string;
  /** Roles that can open the route even when a legacy permission link is missing. */
  roles?: string[];
}

export const navigation: Array<{ label: string; items: NavigationItem[] }> = [
  { label: 'Overview', items: [{ label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.view' }] },
  { label: 'Executive', items: [{ label: 'CEO Command Dashboard', to: '/ceo-dashboard', icon: Crown, permission: 'ceo.dashboard', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Executive Intelligence', to: '/ceo/intelligence', icon: BrainCircuit, permission: 'ceo.dashboard', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'AI Insight Centre', to: '/ceo/ai-insights', icon: BrainCircuit, permission: 'ceo.dashboard', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Approval Centre', to: '/ceo/approvals', icon: ClipboardCheck, permission: 'ceo.approvals.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Executive workspace', to: '/ceo/workspace', icon: LockKeyhole, permission: 'ceo.workspace', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'CEO settings', to: '/ceo/settings', icon: ShieldAlert, permission: 'ceo.settings.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Meetings', to: '/data/meetings', icon: CalendarClock, permission: 'meetings.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive', 'admin', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'employee'] }, { label: 'Company portfolio', to: '/projects', icon: BriefcaseBusiness, permission: 'projects.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Executive employees', to: '/data/users', icon: UsersRound, permission: 'employees.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Executive finance', to: '/invoices', icon: ReceiptText, permission: 'billing.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Payments', to: '/data/payments', icon: WalletCards, permission: 'payments.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Audit centre', to: '/ceo/audit', icon: ShieldAlert, permission: 'ceo.audit.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Delegations', to: '/data/ceo_delegations', icon: Crown, permission: 'ceo.delegation.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Announcements', to: '/data/ceo_announcements', icon: FileText, permission: 'ceo.workspace', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Expenses & budgets', to: '/data/expenses', icon: WalletCards, permission: 'expenses.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Leads & quotations', to: '/data/leads', icon: FileText, permission: 'leads.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive'] }] },
  { label: 'Work', items: [{ label: 'Tasks', to: '/tasks', icon: CheckSquare, permission: 'task.view', roles: ['employee'] }, { label: 'Projects', to: '/projects', icon: BriefcaseBusiness, permission: 'departments.view' }, { label: 'Teams', to: '/data/teams', icon: UsersRound, permission: 'teams.view' }, { label: 'Drive', to: '/data/drive_items', icon: FolderOpen, permission: 'drive.view' }, { label: 'Remote Work', to: '/remote-work', icon: CalendarClock, permission: 'remotework.view' }] },
  { label: 'People', items: [{ label: 'Employees', to: '/data/users', icon: UsersRound, permission: 'employees.view' }, { label: 'Departments', to: '/data/departments', icon: Building2, permission: 'departments.view' }, { label: 'Attendance', to: '/attendance', icon: CalendarClock }, { label: 'Live Workforce', to: '/workforce', icon: Radar, permission: 'attendance.view' }, { label: 'Leave', to: '/leave', icon: CalendarClock }, { label: 'Payroll & Salary', to: '/payroll', icon: WalletCards, permission: 'payroll.view', roles: ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource'] }, { label: 'Recruitment', to: '/data/recruitment_applicants', icon: ClipboardList, permission: 'recruitments.applicants.view' }] },
  { label: 'Finance', items: [{ label: 'Invoices', to: '/invoices', icon: ReceiptText, permission: 'billing.view', roles: ['admin', 'hr', 'hr_manager', 'human_resources', 'human_resource'] }, { label: 'Clients', to: '/data/clients', icon: HandCoins, permission: 'clients.view' }, { label: 'Billing Profiles', to: '/data/billing_profiles', icon: Landmark, permission: 'billing.view' }, { label: 'Maintenance', to: '/data/maintenance_contracts', icon: ReceiptText, permission: 'billing.view' }] },
  { label: 'Collaboration', items: [{ label: 'Corporate Calendar', to: '/calendar', icon: CalendarClock, permission: 'calendar.view', roles: ['ceo', 'chief_executive_officer', 'chief_executive', 'admin', 'hr', 'hr_manager', 'human_resources', 'human_resource', 'manager', 'employee'] }, { label: 'Messenger', to: '/messenger', icon: MessageCircle }, { label: 'Notifications', to: '/notifications', icon: FileText }] },
  { label: 'Administration', items: [{ label: 'Roles', to: '/data/roles', icon: ShieldCheck, permission: 'rbac.view' }, { label: 'Permissions', to: '/data/permissions', icon: Scale, permission: 'rbac.view' }, { label: 'Branding', to: '/settings/branding', icon: Palette, permission: 'rbac.manage' }, { label: 'Backup & Restore', to: '/admin/backups', icon: DatabaseBackup, permission: 'rbac.manage', roles: ['admin', 'administrator', 'ceo', 'chief_executive_officer', 'chief_executive'] }, { label: 'Clara AI', to: '/admin/clara', icon: Sparkles, permission: 'rbac.manage', roles: ['admin', 'administrator'] }, { label: 'Data Archive', to: '/archive', icon: FileText }] }
];

export function readableCollectionName(value: string): string {
  return value.split('_').map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

const relationFieldLabels: Record<string, string> = {
  department_id: 'Department',
  team_id: 'Team',
  lead_user_id: 'Lead user',
  project_id: 'Project',
  assignee_id: 'Assignee',
  leader_id: 'Leader',
  parent_id: 'Parent folder',
  head_user_id: 'Department head',
  position_id: 'Position',
  client_id: 'Client'
};

export function readableFieldName(value: string): string {
  return relationFieldLabels[value] ?? readableCollectionName(value);
}

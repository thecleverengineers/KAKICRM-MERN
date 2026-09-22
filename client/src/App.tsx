import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, ProtectedScreen } from './components/AppShell.js';
import { ArchivePage } from './pages/ArchivePage.js';
import { AttendancePage } from './pages/AttendancePage.js';
import { BrandingSettingsPage } from './pages/BrandingSettingsPage.js';
import { WhatsAppBusinessSettingsPage } from './pages/WhatsAppBusinessSettingsPage.js';
import { WhatsAppCampaignsPage } from './pages/WhatsAppCampaignsPage.js';
import { BackupRestorePage } from './pages/BackupRestorePage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ClaraControlCentrePage } from './pages/ClaraControlCentrePage.js';
import { CeoApprovalsPage } from './pages/CeoApprovalsPage.js';
import { CeoAuditPage } from './pages/CeoAuditPage.js';
import { CeoDashboardPage } from './pages/CeoDashboardPage.js';
import { CeoAiInsightsPage } from './pages/CeoAiInsightsPage.js';
import { CeoIntelligencePage } from './pages/CeoIntelligencePage.js';
import { CeoSettingsPage } from './pages/CeoSettingsPage.js';
import { CeoWorkspacePage } from './pages/CeoWorkspacePage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { CredentialVaultPage } from './pages/CredentialVaultPage.js';
import { EntityPage } from './pages/EntityPage.js';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.js';
import { InvoicesPage } from './pages/InvoicesPage.js';
import { LeavePage } from './pages/LeavePage.js';
import { LeaveDetailPage } from './pages/LeaveDetailPage.js';
import { LiveWorkforcePage } from './pages/LiveWorkforcePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MessengerPage } from './pages/MessengerPage.js';
import { MeetingDetailPage } from './pages/MeetingDetailPage.js';
import { MeetingsPage } from './pages/MeetingsPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { NotificationsPage } from './pages/NotificationsPage.js';
import { DepartmentProjectsPage } from './pages/DepartmentProjectsPage.js';
import { EmployeeDetailPage } from './pages/EmployeeDetailPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ProjectWorkspacePage } from './pages/ProjectWorkspacePage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage.js';
import { PublicHomePage } from './pages/PublicHomePage.js';
import { PayrollPage } from './pages/PayrollPage.js';
import { RecordDetailPage } from './pages/RecordDetailPage.js';
import { RemoteWorkPage } from './pages/RemoteWorkPage.js';
import { MySalaryPage } from './pages/MySalaryPage.js';
import { SalarySlipPage } from './pages/SalarySlipPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { TeamWorkspacePage } from './pages/TeamWorkspacePage.js';
import { isCeoRole } from './lib/ceo.js';
import { useAuth } from './store/auth.js';

export function App() {
  return <Routes>
    <Route path="/" element={<PublicHomePage />} />
    <Route path="/privacy" element={<PrivacyPolicyPage />} />
    <Route path="/login" element={<LoginPage />} />
    <Route element={<ProtectedScreen><AppShell /></ProtectedScreen>}>
      <Route path="/dashboard" element={<RoleAwareDashboard />} />
      <Route path="/calendar" element={<CalendarPage />} />
      <Route path="/ceo-dashboard" element={<CeoDashboardPage />} />
      <Route path="/ceo/intelligence" element={<CeoIntelligencePage />} />
      <Route path="/ceo/ai-insights" element={<CeoAiInsightsPage />} />
      <Route path="/ceo/approvals" element={<CeoApprovalsPage />} />
      <Route path="/ceo/settings" element={<CeoSettingsPage />} />
      <Route path="/ceo/workspace" element={<CeoWorkspacePage />} />
      <Route path="/ceo/audit" element={<CeoAuditPage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/credential-vault" element={<CredentialVaultPage />} />
      <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/departments/:departmentId" element={<DepartmentProjectsPage />} />
      <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
      <Route path="/data/departments" element={<ProjectsPage />} />
      <Route path="/data/departments/manage" element={<EntityPage resourceIdOverride="departments" />} />
      <Route path="/data/departments/:departmentId/projects" element={<DepartmentProjectsPage />} />
      <Route path="/data/departments/:departmentId/projects/:projectId" element={<ProjectWorkspacePage />} />
      <Route path="/data/teams/:teamId" element={<TeamWorkspacePage />} />
      <Route path="/data/users/:employeeId" element={<EmployeeDetailPage />} />
      <Route path="/invoices" element={<InvoicesPage />} />
      <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
      <Route path="/attendance" element={<AttendancePage />} />
      <Route path="/workforce" element={<LiveWorkforcePage />} />
      <Route path="/leave" element={<LeavePage />} />
      <Route path="/leave/:leaveId" element={<LeaveDetailPage />} />
      <Route path="/remote-work" element={<RemoteWorkPage />} />
      <Route path="/messenger" element={<MessengerPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/data/meetings" element={<MeetingsPage />} />
      <Route path="/data/meetings/:meetingId" element={<MeetingDetailPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/my-salary" element={<MySalaryPage />} />
      <Route path="/payroll" element={<PayrollPage />} />
      <Route path="/payroll/slips/:slipId" element={<SalarySlipPage />} />
      <Route path="/archive" element={<ArchivePage />} />
      <Route path="/settings/branding" element={<BrandingSettingsPage />} />
      <Route path="/settings/site" element={<BrandingSettingsPage />} />
      <Route path="/settings/whatsapp-business" element={<WhatsAppBusinessSettingsPage />} />
      <Route path="/whatsapp-campaigns" element={<WhatsAppCampaignsPage />} />
      <Route path="/admin/backups" element={<BackupRestorePage />} />
      <Route path="/admin/clara" element={<ClaraControlCentrePage />} />
      <Route path="/data/:resourceId/:recordId" element={<RecordDetailPage />} />
      <Route path="/data/:resourceId" element={<EntityPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
    <Route path="*" element={<NotFoundPage />} />
  </Routes>;
}

function RoleAwareDashboard() {
  const { user } = useAuth();
  return isCeoRole(user?.role) ? <Navigate to="/ceo-dashboard" replace /> : <DashboardPage />;
}

# Legacy coverage map

## Audit basis

The supplied archive was reviewed as application code, excluding the third-party `vendor` directory and uploaded binary files. It contains approximately 51,470 PHP lines across the entrypoint, modules, controllers, core helpers, and rendered views. The database dump defines 84 KAKI CRM tables.

The modern application does not try to infer a reduced data model and discard unfamiliar fields. Each source table maps to a MongoDB collection of the same name, with:

- `legacyId`: the original numeric primary key when one exists;
- `legacyCompositeKey`: a deterministic key for no-primary-key tables;
- `raw`: the complete imported source row;
- immutable migration run evidence in `migration_runs`.

## Functional mapping

| Legacy area | Original implementation | Modern application surface |
| --- | --- | --- |
| Authentication & RBAC | `AuthController`, `RbacController`, roles and permission views | JWT sign-in compatible with existing bcrypt hashes; role/permission evaluation; protected React navigation and RBAC API middleware. |
| Dashboard & personal to-dos | `DashboardController`, dashboard view | Live dashboard metrics, task priorities, notifications, `employee_todos` data page. |
| Employees & organisation | Employee, department and team controllers/views | Employee, department, team and project data pages; legacy job history, assets, KYC and department-head records remain available in the archive. |
| Task management | Task, update, follower, time, files and chat controllers/views | Dedicated task list/detail workspace; progress updates, chat, followers, time logs, attachments, task notifications and real-time event hooks. |
| Attendance | Attendance controller/views | Clock in/out, break handling, overtime requests/review, daily shifts/logs, and an Admin/HR live workforce command centre with daily workflow visibility and management actions. |
| Remote work | RemoteWork controller/views | Remote shifts, daily check-ins and timer workflows. |
| Leave | Leave controller/views | Apply, cancel, approve/reject, proof-file records and attendance records for approved leave. |
| Payroll & salary | Payroll and salary controllers/views; payroll cron | Payroll run/calculation API, monthly payroll history, salary structures/profiles and source slips/items preserved. |
| Client CRM & billing | Clients, billing profiles, billing and maintenance controllers/views | Clients, billing profiles, contracts, invoices, editable and archive-safe line items, automatic tax/balance recalculation, payments, totals, status updates, printable A4 invoice view and recurring contract invoice endpoint. |
| Drive & files | Drive, task file, project file and candidate document controllers | Authenticated upload APIs, folder/file endpoints and retained storage-path references; all source-file records preserved. |
| Recruitment & candidate documents | Recruitments and candidate-docs controllers/views | Positions/applicants, stage history, recruitment attachments and candidate document tables. |
| Messenger & notifications | Messenger, notification controllers, socket/daemon files | Direct/group conversations, participant records, messages, attachments, read state, notifications and Socket.IO event delivery. |
| Migration reconciliation | No equivalent in the legacy app | Admin-only archive page exposes every imported collection and record count for pre-cut-over validation. |

## All imported collections

### Organisation, work and documents

`activity_logs`, `announcements`, `announcement_reads`, `daily_checkins`, `daily_reports`, `departments`, `department_heads`, `department_projects`, `drive_items`, `employees`, `employee_assets`, `employee_job_history`, `employee_kyc_documents`, `employee_todos`, `files`, `folders`, `project_files`, `teams`, `team_members`, `team_messages`, `timesheets`, `time_logs`, `user_work_sessions`, `users`, `weekly_reports`.

### Tasks and task collaboration

`tasks`, `task_chat`, `task_chats`, `task_chat_attachments`, `task_chat_mentions`, `task_chat_polls`, `task_chat_poll_options`, `task_chat_poll_votes`, `task_files`, `task_followers`, `task_notifications`, `task_time_logs`, `task_updates`, `task_update_files`, `task_update_people`, `task_update_progress`, `task_update_tags`, `task_work_updates`.

### Attendance, leave, salary and payroll

`attendance_breaks`, `attendance_logs`, `attendance_overtime`, `attendance_shifts`, `leave_requests`, `leave_request_files`, `payroll_auto_logs`, `payroll_items`, `payroll_monthly`, `payroll_runs`, `salary_profiles`, `salary_slips`, `salary_structures`.

### CRM, billing and recurring maintenance

`billing_profiles`, `clients`, `client_contacts`, `client_invoices`, `client_invoice_items`, `client_maintenance_contracts`, `client_projects`, `invoices`, `invoice_items_new`, `maintenance_contracts`, `payments`.

### Recruitment, communication and access control

`hr_candidates`, `hr_candidate_docs`, `messenger_attachments`, `messenger_conversations`, `messenger_message_reactions`, `messenger_messages`, `messenger_participants`, `notification_import_state`, `notifications`, `permissions`, `recruitment_applicant_logs`, `recruitment_applicants`, `recruitment_files`, `recruitment_positions`, `remote_shifts`, `role_permissions`, `roles`.

## Preservation rules

1. Never overwrite or delete the original PHP folder, MySQL database, ZIP, SQL dump, or uploaded files during import.
2. Retain source numeric IDs and use them for every existing relationship.
3. Do not expose password hashes, API keys, reset tokens or similar sensitive source fields in public API responses.
4. Archive a modern record instead of hard-deleting it through the generic data API.
5. Run the dry-run and compare its table counts before a live MongoDB import.

# KAKI CRM Modern

A migration-first React + Node.js + MongoDB rebuild of the supplied KAKI CRM. It is designed to run next to the current PHP/MySQL application, verify the import, and only then become the production system.

## What is preserved

- Every source MySQL table is imported to a matching MongoDB collection.
- Every original row is retained verbatim inside `raw`, together with its original numeric `legacyId` (or a deterministic composite key for tables without an `id`).
- Existing relationships continue to work through the original IDs; the migration does not renumber users, tasks, invoices, attendance records, or files.
- Existing password hashes are kept intact. PHP bcrypt hashes work with Node's bcrypt verification, so users do not need a password reset.
- Uploaded source files are copied without renaming into `server/uploads/legacy/<original-relative-path>`.

## Quick start

1. Install Node.js 20.11+ and run MongoDB 4.2+ locally (MongoDB 8 is supported).
2. In this directory run `npm install`.
3. Copy `.env.example` to `.env` and set strong JWT and settings-encryption secrets.
4. Set `MONGODB_URI` in `.env` to your local MongoDB service, for example `mongodb://127.0.0.1:27017/kaki_crm_modern`.
5. Import a dry run first:

   ```bash
   npm run migrate:legacy -- --sql ../upload/localhost.sql --assets ../legacy-source/kakicrm.store --dry-run
   ```

6. Review the printed table counts, then run the same command without `--dry-run`.
7. Verify the live MongoDB import against the exact SQL checksum:

   ```bash
   npm run verify:legacy -- --sql ../upload/localhost.sql
   ```

8. Start the application with `npm run dev` and open `http://localhost:5173`.

The importer is idempotent: it upserts by the original `legacyId`/composite key, so it can be re-run safely after correcting source data. It never writes to the MySQL dump or the old PHP directory.

## Production sequence

1. Put the existing PHP CRM into read-only/maintenance mode for the final sync window.
2. Take a fresh MySQL dump and a full copy of its upload/storage directories.
3. Run the migration against that final snapshot.
4. Compare `migration_runs` counts with MySQL row counts and spot-check users, invoices, task threads, leave attachments, and payroll slips.
5. Open the production CRM only through `https://www.kakicrm.store/` after validation is signed off. Nginx forwards that HTTPS domain to the private local Node.js service.

See [migration guide](docs/MIGRATION_GUIDE.md) and [legacy coverage map](docs/LEGACY_COVERAGE.md).

## Live workforce command centre

Admins and HR users with `attendance.view` can open **Live Workforce** from the People menu. It provides live attendance status, active break status, daily task workload, daily check-ins, overdue-work signals, and automatic Socket.IO refresh with a 30-second fallback refresh.

Users with `attendance.manage` can mark an employee present or absent, close a live shift, and send a workflow follow-up notification. Live attendance management intentionally applies only to the current India Standard Time date. The dashboard is responsive across desktop, tablet, and mobile, and its day/night control is saved per browser.

When an employee starts their own shift, every active Admin and HR user (including custom roles with `attendance.view` or `attendance.manage`) receives a persistent CRM notification, a live visual alert and a spoken announcement. The browser selects the best available female-sounding English system voice; if one is not installed, it uses the browser's English fallback voice. The alert works across the CRM, not only on the Live Workforce page.

## Day and night mode

The saved day/night preference now applies consistently to the application shell, tables, forms, modals, dashboards, department/project/team Kanban boards, live-workforce screens, messaging, notification centre and live shift-start alerts. The sign-in screen has the same toggle and keeps the chosen preference after sign-in. The A4 invoice remains deliberately white with black document text in both modes so its print/PDF layout is unchanged.

The dashboard also has a large top-level **Start shift / End shift** command. It shows live shift state and elapsed time, prevents an invalid end while a break is active, and refreshes attendance, dashboard and live-workforce data immediately after an action.

On phones, the CRM switches to an app-style bottom navigation bar with Home, Tasks, Shift, Alerts and More icons. It respects each user’s permissions, keeps the active area highlighted and adds safe-area spacing so page actions are never hidden behind the bar.

## WhatsApp task-assignment notifications

When a task is assigned from the main Tasks page, a Project workspace, or a Team workspace, KAKI CRM sends the selected assignee's saved WhatsApp number through the approved Fast2SMS `my_task` utility template. The task is still created if Fast2SMS is temporarily unavailable.

For the first deployment, set a stable `SETTINGS_ENCRYPTION_SECRET` in `.env`.
An administrator can then open **Administration → Branding, invoices & integrations** and save or replace the Fast2SMS authorisation key. The saved key is encrypted, write-only, and takes effect immediately; it is never returned to the browser. You may alternatively use the deployment-only fallback value:

```dotenv
FAST2SMS_WHATSAPP_API_KEY=your_fast2sms_authorization_key
```

The request uses `GET https://www.fast2sms.com/dev/whatsapp` with `message_id=30840`, `phone_number_id=1202480702956271`, the assigned user's mobile number, and exactly six pipe-separated variable values: assigned by, title, description, status, priority and due date. No media or document attachment is sent.

## Employee task workspace

Every employee can create a task for their own workflow from **Tasks**. The
server scopes the task list and every task-detail action to work the employee
owns, is assigned to, is mentioned in, or is tagged in. Within that scope an
employee can update status and progress, use task chat, add mentions, log time,
attach files, edit task details and archive a task they own or are assigned to.
Company-wide task recycle/restore and reassignment to another employee remain
restricted to authorised task managers, HR and administrators. Confidential
tasks are not revealed through an indirect mention or tag.

## Invoice Excel export

Authorised users can select **Export Excel** on `/invoices` to download a formatted
`.xlsx` workbook. The export includes every invoice matching the current invoice
search, not only the currently visible table page, and includes client, dates,
amounts, status, type and notes.

## Payroll, attendance and employee salary slips

Administrators and HR users can open **People → Payroll & Salary** to set dated employee salary structures, calculate a monthly salary from attendance, and generate a salary slip. The **Attendance** page also provides an HR/Admin-only manual entry form for an employee's date, status, working hours, breaks and overtime.

Employees use the profile menu → **My salary slips**. That page is self-scoped by the server: an employee can view only their own calculated salary history and only their own HR-generated salary slips. Each issued slip includes a browser **Print / save as PDF** action.

## Update an existing PM2 installation

The production update command preserves `.env`, MongoDB data, and `server/uploads`:

```bash
APP_DIR=/www/kaki APP_NAME=kaki-crm bash update-production-pm2.sh
```

For aaPanel or other terminals that may disconnect during `npm ci`, the v14
release also includes `scripts/deploy-production-release.sh`. Extract the ZIP
to a temporary directory and launch that helper in the background; it owns the
entire copy, OAuth configuration, build, PM2 reload and health-check sequence.
It uses named arguments rather than a pasted heredoc, verifies an optional ZIP
checksum, prevents two releases from running at the same time, and retains a
timestamped `/var/backups/kaki-crm-*` application backup. If the build, PM2
reload or health check fails after the swap, the previous application is
restored automatically. The OAuth JSON is optional for later updates: when it
is absent, the deployer preserves the existing `.env` or CEO-managed OAuth
configuration.

For the complete source-copy, HTTPS domain, Nginx and PM2 update command, see [the production domain guide](docs/UPDATE_PM2_DOMAIN.md).

## CEO executive workspace

Set the executive user's display name to **KAKIVI CHISHI** and `role` to `ceo`
(the aliases `chief_executive_officer` and
`chief_executive` are also accepted). CEO accounts receive an explicit,
audited company-wide permission set and are sent to `/ceo-dashboard` after
sign-in. The dashboard is built from CRM facts and provides clickable finance,
project, workforce, client, payroll, approval and agenda cards. The Approval
Centre records approve/reject/return/clarification/delegation decisions,
including the reason and actor. Thresholds and dashboard settings are managed
at `/ceo/settings`; private executive notes are isolated at `/ceo/workspace`.

CEO permissions do not expose passwords, access tokens or encrypted
credentials. Sensitive changes remain explicit and auditable, and the generic
record archive remains soft-delete/recoverable. Clara's CEO answers are
permission-aware CRM summaries; forecasts are labelled recommendations and
Clara never approves payments, changes salary, deletes data or terminates an
employee automatically. `Ctrl/Cmd+K` opens the CEO command palette.

## Google Meet meetings

The Meetings workspace is available at `/data/meetings`. CEO, Admin and HR
users can connect an authorised Google account, schedule a Calendar event with
a Google-generated Meet conference, invite CRM users/clients or external
emails, reschedule, cancel, resend invitations and synchronize attendance.
Employees can view only meetings they organised or were invited to. The
backend enforces these rules even if a navigation link is manually entered.
Join/leave data, multiple sessions, absent invitees and unidentified guests
are stored in MongoDB after an authorised attendance sync. The app displays a
notice that this attendance may be recorded; it never starts recording or
transcription automatically.

### Google Cloud setup

1. Create a Google Cloud project, enable **Google Calendar API** and **Google
   Meet REST API**, and configure an OAuth consent screen.
2. Create a Web OAuth client and add the exact redirect URI
   `https://www.kakicrm.store/api/integrations/google/callback` (use the local URI
   when developing). The site root such as `https://kakicrm.store` is not a
   callback endpoint and must not be used by itself.
3. Put the client ID, secret, redirect URI and a stable random
   `GOOGLE_TOKEN_ENCRYPTION_KEY` in the deployment `.env`. OAuth access and
   refresh tokens are encrypted with AES-256-GCM and never returned to the
   browser.
4. The requested scopes are OpenID/profile/email, Calendar events and the
   Meet space/conference APIs. Reconnect if Google revokes access.
5. `GOOGLE_PUBSUB_*` and `GOOGLE_WORKSPACE_EVENTS_CALLBACK_URL` are reserved
   for an event-driven attendance worker. Until that worker is configured,
   use **Sync attendance** from a completed meeting (the documented safe
   fallback).

The provider callback endpoints are available at `/api/webhooks/google-workspace`
and `/api/webhooks/whatsapp`. They require the matching deployment webhook
token, acknowledge duplicate events idempotently, and store only the event
metadata needed for audit and delivery status. Configure Google Pub/Sub with
an authenticated push subscription (and, where your provider supports it,
the shared `GOOGLE_WORKSPACE_WEBHOOK_TOKEN`) before enabling event-driven
attendance. Meta webhook verification uses `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
The existing Fast2SMS task-assignment integration is not a WhatsApp Cloud API
webhook, so meeting delivery remains in-app until an approved meeting template
and provider adapter are configured.

The meeting routes use Google Calendar's `conferenceDataVersion=1` and a
cryptographically random conference request ID; no Meet URL is fabricated.
Calendar invitations are sent by Google only when the form's invitation option
is enabled. Group messaging is deliberately not automated: the Fast2SMS
integration currently supports the approved task template, while WhatsApp
Cloud/Groups API eligibility varies by WABA. Meeting invitees receive an
in-app CRM notification; add an approved meeting template and provider adapter
before enabling external WhatsApp delivery.

The production scheduler now returns the real provider error instead of a
generic 500 when Google rejects a request. The Meetings page includes **Test
Calendar & Meet**: it performs separate, read-only Calendar `events.list` and
Meet `conferenceRecords.list` checks and reports which API or OAuth permission
failed. **Reconnect Google** first disconnects the old token and starts a fresh
consent flow requesting both current scopes. The page also validates time zones
and invitee addresses before calling Google, uses a request idempotency key to
avoid duplicate events after a browser retry, and protects provider calls with
a bounded timeout. Google conference data is asynchronous; a meeting may
briefly show `Creating`, and its detail page polls until the real Meet URL is
available or Google reports a failed conference.

If the API reports that Google denied Calendar or Meet access, enable both APIs
in the same Cloud project, confirm the exact callback above, and reconnect the
organizer's Google account. If the API reports an invalid invitee, correct or
remove the CRM record's email address; meetings without invitees are still
allowed.

The release also includes a read-only Cloud API check. It reads only the
`project_id` from the OAuth JSON (never the secret), then asks the authenticated
Google Cloud CLI whether `calendar-json.googleapis.com` and `meet.googleapis.com`
are enabled:

```bash
cd /www/kaki
GOOGLE_CLIENT_JSON=/root/client_secret_<your-client-id>.apps.googleusercontent.com.json \
  bash scripts/verify-google-cloud-apis.sh
```

If either service is missing, the check prints the exact `gcloud services
enable … --project …` command. The command is deliberately not run by the CRM
or deployment script; enabling a Google Cloud API is an owner/IAM action.

### Meeting environment variables

See `.env.example` for the complete list, including:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=
GOOGLE_TOKEN_ENCRYPTION_KEY=
GOOGLE_CLOUD_PROJECT_ID=
GOOGLE_PUBSUB_TOPIC=
GOOGLE_PUBSUB_SUBSCRIPTION=
GOOGLE_WORKSPACE_EVENTS_CALLBACK_URL=
GOOGLE_WORKSPACE_WEBHOOK_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
MEETING_ATTENDANCE_SYNC_ENABLED=true
MEETING_REALTIME_EVENTS_ENABLED=false
MEETING_LATE_AFTER_MINUTES=10
MEETING_MINIMUM_ATTENDANCE_PERCENT=50
MEETING_LEFT_EARLY_BEFORE_MINUTES=10
WHATSAPP_GROUPS_ENABLED=false
```

Do not put OAuth secrets, WhatsApp tokens or API keys in a release archive.
# Corporate Calendar

The `/calendar` workspace unifies company holidays and restricted holidays, Google Meet meetings, events, project milestones and deadlines, assigned tasks, shifts, leave/WFH/travel, payroll and invoice dates, client follow-ups, training, reviews, birthdays, anniversaries, compliance and recruitment reminders. It supports day, week, month, year, agenda and timeline modes, search and filters, clickable source records, custom event creation, attendee/location conflict detection, in-app assignment notifications, CSV export and print.

Access is role-aware: CEO has company-wide control, Admin and HR manage entries, department heads require the `calendar.manage` permission, employees see company/permitted and their own entries, and guests only see explicitly shared invitations. Google Calendar/Meet links are surfaced from the existing integration; Outlook synchronization and external email/WhatsApp delivery still require the corresponding provider credentials/connector.

## CEO-managed Google OAuth

The CEO can open **CEO settings → Google Workspace** and save the Google OAuth client ID, client secret, authorized redirect URI, and optional Cloud project ID. The client secret is encrypted with the deployment encryption secret and is write-only. The redirect URI must also be registered in Google Cloud Console (for production, use `https://www.kakicrm.store/api/integrations/google/callback`; use a localhost URI only for a local development client). Saving or clearing the client is recorded in the CEO audit log, and new meeting connections use the saved configuration immediately.

If Google displays `Error 403: access_denied` or says the app has not completed verification, this is a Google Cloud consent-screen restriction, not a CRM API failure. While the OAuth app is in **Testing**, add every person who will connect (including `kaki.helps.brands@gmail.com`) under **Google Cloud Console → Google Auth Platform → Audience → Test users**. Confirm the production OAuth client has the exact `https://www.kakicrm.store/api/integrations/google/callback` redirect URI and that the CEO Settings value is the same. For wider use, complete Google's verification and publish the consent screen. The Meetings page now returns this explanation after a denied consent instead of leaving a blank error page.

For a permanent production setup, copy the downloaded Google Web OAuth JSON to
the server (outside `/www/kaki`) and run the bundled loader once:

```bash
cd /www/kaki
GOOGLE_CLIENT_JSON=/root/client_secret_<your-client-id>.apps.googleusercontent.com.json \
APP_ORIGIN="https://www.kakicrm.store,https://kakicrm.store" \
bash scripts/configure-google-oauth.sh
```

The loader extracts the client ID, secret and Cloud project ID into the
protected `.env`, sets the canonical callback, creates the token-encryption key
if it is missing, and never puts the JSON or secret in a release archive. The
update script preserves this `.env` on every later PM2 deployment. The CEO
settings page can still rotate the client securely; it normalizes a pasted site
root to the callback and rejects unrelated callback paths.

Uploading a downloaded client JSON does not register redirect URIs in Google
Cloud. In **Google Auth Platform → Clients**, add the exact callback
`https://www.kakicrm.store/api/integrations/google/callback` to the same Web
client before reconnecting; the site root alone is not sufficient.

After a deployment, run this read-only check to confirm the correct PM2 process
and private health port are serving without printing a client secret:

```bash
APP_DIR=/www/kaki APP_PORT=4000 PM2_APP_NAME=kaki-crm \
  bash scripts/verify-google-meet-production.sh
```

The archive also contains `scripts/deploy-production-release.sh`, which is a
safe named-argument deployer for aaPanel/SSH sessions. It avoids a nested
heredoc, serializes deployments with a lock, and keeps an automatic rollback
backup. Add
`--verify-google-cloud-apis` when the server has an authenticated `gcloud`
installation and you want the deployment to fail if either required API is
missing; otherwise run `scripts/verify-google-cloud-apis.sh` separately after
the update.

The public home page is available at `https://www.kakicrm.store/` without signing in and explains the product, security model and integrations. The public privacy policy is available at `https://www.kakicrm.store/privacy` and documents account, work, payroll, file, notification, WhatsApp and Google API data, retention, deletion requests, security, service providers and Google API Limited Use commitments. Use those exact URLs in Google Cloud Console → Google Auth Platform → Branding/Audience when submitting the OAuth app for review.

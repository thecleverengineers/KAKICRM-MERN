# KAKI CRM Backup & Restore

The **Administration → Backup & Restore** page creates one encrypted recovery package containing MongoDB data and indexes, application source and compiled release, protected runtime configuration, uploaded files, documents, spreadsheets, PDFs, images, video/media, and any paths configured in `BACKUP_EXTRA_PATHS`.

## Three copies

1. **Server vault:** `/var/backups/kaki-crm`, with 30 recovery points by default.
2. **Google Drive:** unattended upload to the CEO/Admin-selected folder after every backup, with 180-day retention by default.
3. **Local computer:** click **Download** beside any recovery point. Browsers require the user to approve the destination, so a website cannot silently write a daily file to a local computer.

## Google Drive one-time setup

1. In the Google Cloud project used by KAKI CRM, enable **Google Drive API**. Calendar and Meet users should also keep their respective APIs enabled.
2. In **CEO Settings → Google OAuth client**, save a Web application OAuth client. Add the exact callback shown by the CRM to the client's authorized redirect URIs.
3. If the consent screen is in Testing, add the CEO/Admin Google account under **Audience → Test users**.
4. Open **Administration → Backup & Restore** as CEO or Administrator and select **Connect Google Drive**.
5. Sign in to the Google account that will own the backups and approve the limited Drive-file permission.
6. Select **Create & connect** to create the recommended `KAKI CRM Backups` folder in that account's My Drive. A folder URL/ID can be reconnected when it was previously created or authorized by this CRM OAuth client.
7. Run **Test write access**, then create one manual backup and confirm its encrypted archive and checksum appear in the folder.

The CRM stores access and refresh tokens encrypted in MongoDB. The systemd job uses the refresh token for unattended uploads; no Google password or service-account key is stored. The limited `drive.file` scope lets the CRM work only with files and folders that it creates or that were explicitly authorized for it.

## Automatic schedule

`kaki-crm-backup.timer` runs every day at **5:30 PM Asia/Kolkata**. A Drive outage does not destroy or invalidate the encrypted server copy. The Backup & Restore page records the Drive result and last error so an operator can retry manually.

## Recovery safeguards

- CEO/Administrator-only endpoints and authenticated downloads.
- AES-256 GPG encryption; the passphrase lives only in the protected `.env`.
- Outer SHA-256 checksum plus checksums for every decrypted payload file.
- Resumable Drive upload with retries for large archives.
- Archive path validation before extraction.
- Exact restore confirmation phrase.
- Automatic pre-restore recovery point and database safety snapshot.
- Atomic application-directory switch and rollback attempt if database restore fails.

Keep an offline copy of `BACKUP_ENCRYPTION_PASSPHRASE` in a password manager. An encrypted backup cannot be recovered without it.

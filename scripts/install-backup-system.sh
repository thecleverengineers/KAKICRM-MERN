#!/usr/bin/env bash
# Installs KAKI CRM's daily encrypted backup timer and CEO-owned Google Drive replica.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

APP_DIR="${APP_DIR:-/www/kaki}"
ENV_FILE="$APP_DIR/.env"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/kaki-crm}"
PM2_APP_NAME="${PM2_APP_NAME:-kaki-crm}"

info(){ printf '\n[KAKI BACKUP SETUP] %s\n' "$*"; }
warn(){ printf '\n[KAKI BACKUP WARNING] %s\n' "$*" >&2; }
die(){ printf '\n[KAKI BACKUP ERROR] %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die 'Run as root.'
[ -f "$ENV_FILE" ] || die "Missing $ENV_FILE"
[ -f "$APP_DIR/scripts/backup-engine.sh" ] || die 'Backup engine is missing from the release.'
[ -f "$APP_DIR/scripts/google-drive-backup.mjs" ] || die 'Google Drive backup uploader is missing from the release.'

set_env(){
  local key="$1" value="$2" escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"; else printf '\n%s=%s\n' "$key" "$value" >>"$ENV_FILE"; fi
}
get_env(){ sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }

if ! command -v gpg >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die 'Install gnupg, then rerun this setup.'
  info 'Installing encrypted-backup tools'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnupg ca-certificates
fi

install -d -m 0700 "$BACKUP_ROOT"
chmod 700 "$APP_DIR/scripts/backup-engine.sh" "$APP_DIR/scripts/install-backup-system.sh" "$APP_DIR/scripts/mongodb-portable-backup.mjs" "$APP_DIR/scripts/google-drive-backup.mjs"

if [ -z "$(get_env BACKUP_ENCRYPTION_PASSPHRASE)" ]; then
  set_env BACKUP_ENCRYPTION_PASSPHRASE "$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"
fi
set_env BACKUP_ROOT "$BACKUP_ROOT"
set_env BACKUP_ENGINE_PATH "$APP_DIR/scripts/backup-engine.sh"
set_env BACKUP_LOCAL_RETENTION_COUNT "$(get_env BACKUP_LOCAL_RETENTION_COUNT || true)"
[ -n "$(get_env BACKUP_LOCAL_RETENTION_COUNT)" ] || set_env BACKUP_LOCAL_RETENTION_COUNT 30
[ -n "$(get_env BACKUP_DRIVE_RETENTION_DAYS)" ] || set_env BACKUP_DRIVE_RETENTION_DAYS 180

cat > /etc/systemd/system/kaki-crm-backup.service <<EOF
[Unit]
Description=KAKI CRM encrypted full-system backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Environment=APP_DIR=$APP_DIR
Environment=BACKUP_ROOT=$BACKUP_ROOT
ExecStart=/bin/bash $APP_DIR/scripts/backup-engine.sh create scheduled systemd-timer
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=$APP_DIR
ReadWritePaths=$BACKUP_ROOT
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=6h
EOF

cat > /etc/systemd/system/kaki-crm-backup.timer <<'EOF'
[Unit]
Description=Run KAKI CRM backup daily at 5:30 PM India time

[Timer]
OnCalendar=*-*-* 17:30:00 Asia/Kolkata
Persistent=true
RandomizedDelaySec=0
AccuracySec=1min
Unit=kaki-crm-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now kaki-crm-backup.timer
systemctl is-enabled --quiet kaki-crm-backup.timer
systemctl list-timers kaki-crm-backup.timer --no-pager

info 'Backup system installed: daily 5:30 PM Asia/Kolkata'
warn 'A CEO or administrator must open Backup & Restore, connect their Google account, and create/select the Drive folder. Server and local-download copies work before this step.'

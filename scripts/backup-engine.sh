#!/usr/bin/env bash
# KAKI CRM encrypted full-system backup and disaster-recovery engine.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

COMMAND="${1:-}"
ARGUMENT="${2:-}"
ACTOR="${3:-system}"
APP_DIR="${APP_DIR:-/www/kaki}"
ENV_FILE="${APP_DIR}/.env"

die() { printf '[KAKI BACKUP ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[KAKI BACKUP] %s\n' "$*"; }
require() { command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"; }
read_env() {
  local key="$1" fallback="${2:-}"
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return; fi
  local value
  value="$(cd "$APP_DIR" && node --input-type=module -e "import{readFileSync}from'node:fs';import dotenv from'dotenv';const v=dotenv.parse(readFileSync(process.argv[1]))[process.argv[2]];if(typeof v==='string')process.stdout.write(v)" "$ENV_FILE" "$key")"
  printf '%s' "${value:-$fallback}"
}

[ -f "$ENV_FILE" ] || die "Production environment file not found: $ENV_FILE"
require node; require tar; require gpg; require sha256sum; require flock

BACKUP_ROOT="${BACKUP_ROOT:-$(read_env BACKUP_ROOT /var/backups/kaki-crm)}"
PASSPHRASE="$(read_env BACKUP_ENCRYPTION_PASSPHRASE)"
MONGODB_URI="$(read_env MONGODB_URI)"
RETENTION_COUNT="$(read_env BACKUP_LOCAL_RETENTION_COUNT 30)"
EXTRA_PATHS="$(read_env BACKUP_EXTRA_PATHS '')"
PM2_APP_NAME="$(read_env PM2_APP_NAME kaki-crm)"
PORT="$(read_env PORT 4000)"
STATE_FILE="$BACKUP_ROOT/.state.json"
LOG_FILE="$BACKUP_ROOT/backup.log"
LOCK_FILE="$BACKUP_ROOT/.operation.lock"
TEMP_DIR=""

[ -n "$PASSPHRASE" ] || die 'BACKUP_ENCRYPTION_PASSPHRASE is missing.'
[ -n "$MONGODB_URI" ] || die 'MONGODB_URI is missing.'
install -d -m 0700 "$BACKUP_ROOT"
exec >>"$LOG_FILE" 2>&1
exec 9>"$LOCK_FILE"
flock -n 9 || die 'Another backup or restore operation is already running.'

cleanup() { [ -z "$TEMP_DIR" ] || rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT

json_string() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
write_state() {
  local operation="$1" status="$2" message="$3" backup_id="${4:-}"
  printf '{"operation":%s,"status":%s,"startedAt":%s,"finishedAt":%s,"message":%s,"backupId":%s}\n' \
    "$(json_string "$operation")" "$(json_string "$status")" "$(json_string "${STARTED_AT:-$(date -u +%FT%TZ)}")" \
    "$(json_string "$([ "$status" = running ] && printf '' || date -u +%FT%TZ)")" "$(json_string "$message")" "$(json_string "$backup_id")" >"$STATE_FILE"
}
fail_state() { local code="$?"; write_state "${OPERATION:-backup}" failed "Operation failed. Review $LOG_FILE." "${BACKUP_ID:-}"; exit "$code"; }
trap fail_state ERR

database_backup() {
  local destination="$1"
  MONGODB_URI="$MONGODB_URI" node "$APP_DIR/scripts/mongodb-portable-backup.mjs" backup "$destination"
}
database_restore() {
  local source="$1"
  MONGODB_URI="$MONGODB_URI" node "$APP_DIR/scripts/mongodb-portable-backup.mjs" restore "$source"
}

create_backup() {
  local trigger="$1" actor="$2" upload_drive="${3:-true}"
  OPERATION=backup; STARTED_AT="$(date -u +%FT%TZ)"
  local stamp slug archive payload pass_file cloud=disabled create_temp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"; slug="$(printf '%s' "$trigger" | tr -cd 'A-Za-z0-9_-' | tr A-Z a-z)"
  BACKUP_ID="kaki-crm-backup-${stamp}-${slug:-manual}.tar.gz.gpg"; archive="$BACKUP_ROOT/$BACKUP_ID"
  write_state backup running "Creating encrypted full-system recovery point." "$BACKUP_ID"
  create_temp="$(mktemp -d /tmp/kaki-backup.XXXXXX)"; payload="$create_temp/payload"; install -d -m 0700 "$payload/database"
  info "Starting $trigger backup requested by $actor"
  database_backup "$payload/database"
  tar --exclude='./node_modules' --exclude='./server/uploads/.tmp' --exclude='./.git' --exclude='*.log' -czf "$payload/application.tar.gz" -C "$APP_DIR" .
  if [ -n "$EXTRA_PATHS" ]; then
    install -d -m 0700 "$payload/extra"
    while IFS= read -r extra; do
      [ -z "$extra" ] && continue
      [ -e "$extra" ] || { info "Skipping missing extra path: $extra"; continue; }
      tar -czf "$payload/extra/$(printf '%s' "$extra" | sha256sum | cut -c1-16).tar.gz" -C / "${extra#/}"
    done < <(printf '%s' "$EXTRA_PATHS" | tr ',' '\n')
  fi
  printf '{"format":1,"product":"KAKI CRM","createdAt":%s,"trigger":%s,"actor":%s,"contents":["database","application","uploads","documents","media","configuration","source"],"applicationRoot":%s}\n' \
    "$(json_string "$STARTED_AT")" "$(json_string "$trigger")" "$(json_string "$actor")" "$(json_string "$APP_DIR")" >"$payload/manifest.json"
  (cd "$payload" && find . -type f ! -name CHECKSUMS.sha256 -print0 | sort -z | xargs -0 sha256sum >CHECKSUMS.sha256)
  tar -czf "$create_temp/bundle.tar.gz" -C "$payload" .
  pass_file="$create_temp/passphrase"; printf '%s' "$PASSPHRASE" >"$pass_file"; install -d -m 0700 "$create_temp/gnupg"
  GNUPGHOME="$create_temp/gnupg" gpg --batch --yes --pinentry-mode loopback --passphrase-file "$pass_file" --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 --output "$archive" "$create_temp/bundle.tar.gz"
  sha256sum "$archive" | sed "s#  .*#  $BACKUP_ID#" >"$archive.sha256"
  if [ "$upload_drive" = true ]; then
    cloud=pending
    if MONGODB_URI="$MONGODB_URI" APP_DIR="$APP_DIR" node "$APP_DIR/scripts/google-drive-backup.mjs" upload "$archive" "$archive.sha256"; then
      cloud=uploaded
    else
      drive_status="$?"
      if [ "$drive_status" -eq 3 ]; then cloud=not_configured; else cloud=failed; fi
      info "Google Drive copy was not completed (status $drive_status); the encrypted server copy is safe."
    fi
  fi
  printf '{"createdAt":%s,"trigger":%s,"actor":%s,"cloud":%s}\n' "$(json_string "$STARTED_AT")" "$(json_string "$trigger")" "$(json_string "$actor")" "$(json_string "$cloud")" >"$archive.json"
  mapfile -t old_backups < <(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'kaki-crm-backup-*.tar.gz.gpg' -printf '%T@ %p\n' | sort -nr | tail -n +"$((RETENTION_COUNT + 1))" | cut -d' ' -f2-)
  for old in "${old_backups[@]:-}"; do [ -n "$old" ] && rm -f -- "$old" "$old.sha256" "$old.json"; done
  write_state backup success "Backup created successfully; Drive status: $cloud." "$BACKUP_ID"
  info "Backup completed: $archive"
  rm -rf -- "$create_temp"
}

decrypt_and_validate() {
  local archive="$1" destination="$2" pass_file="$TEMP_DIR/passphrase"
  [ -f "$archive" ] || die "Backup archive not found: $archive"
  if [ -f "$archive.sha256" ]; then (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256"); fi
  printf '%s' "$PASSPHRASE" >"$pass_file"; install -d -m 0700 "$TEMP_DIR/gnupg"
  GNUPGHOME="$TEMP_DIR/gnupg" gpg --batch --yes --pinentry-mode loopback --passphrase-file "$pass_file" --decrypt --output "$TEMP_DIR/bundle.tar.gz" "$archive"
  tar -tzf "$TEMP_DIR/bundle.tar.gz" | awk 'BEGIN{bad=0} /^\// || /(^|\/)\.\.($|\/)/ {bad=1} END{exit bad}' || die 'Unsafe path detected inside backup.'
  install -d -m 0700 "$destination"; tar -xzf "$TEMP_DIR/bundle.tar.gz" -C "$destination"
  (cd "$destination" && sha256sum -c CHECKSUMS.sha256)
  [ -f "$destination/manifest.json" ] && [ -f "$destination/application.tar.gz" ] && [ -f "$destination/database/manifest.json" ] || die 'Backup payload is incomplete.'
}

verify_backup() {
  local archive="$1"; OPERATION=verify; STARTED_AT="$(date -u +%FT%TZ)"; BACKUP_ID="$(basename "$archive")"
  write_state verify running 'Checking checksum, encryption and every payload file.' "$BACKUP_ID"
  TEMP_DIR="$(mktemp -d /tmp/kaki-verify.XXXXXX)"; decrypt_and_validate "$archive" "$TEMP_DIR/verified"
  local metadata="$archive.json"; if [ -f "$metadata" ]; then node -e "const fs=require('fs');const p=process.argv[1],x=JSON.parse(fs.readFileSync(p));x.verifiedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(x,null,2)+'\\n',{mode:0o600})" "$metadata"; fi
  write_state verify success 'Backup checksum, decryption and internal file verification passed.' "$BACKUP_ID"
}

restore_backup() {
  local archive="$1" actor="$2" restore_payload restore_app rollback_app safety_db
  OPERATION=restore; STARTED_AT="$(date -u +%FT%TZ)"; BACKUP_ID="$(basename "$archive")"
  write_state restore running 'Validating recovery package before making changes.' "$BACKUP_ID"
  TEMP_DIR="$(mktemp -d /tmp/kaki-restore.XXXXXX)"; restore_payload="$TEMP_DIR/payload"; decrypt_and_validate "$archive" "$restore_payload"
  restore_app="$(dirname "$APP_DIR")/.kaki-restore-$(date -u +%Y%m%dT%H%M%SZ)"; install -d -m 0700 "$restore_app"
  tar -tzf "$restore_payload/application.tar.gz" | awk 'BEGIN{bad=0} /^\// || /(^|\/)\.\.($|\/)/ {bad=1} END{exit bad}' || die 'Unsafe application path detected.'
  tar -xzf "$restore_payload/application.tar.gz" -C "$restore_app"
  [ -f "$restore_app/package.json" ] && [ -f "$restore_app/.env" ] || die 'Restored application is incomplete.'
  (cd "$restore_app" && npm ci --omit=dev --ignore-scripts)
  safety_db="$TEMP_DIR/safety-database"; database_backup "$safety_db"
  create_backup pre-restore "$actor" false
  OPERATION=restore; BACKUP_ID="$(basename "$archive")"
  rollback_app="$(dirname "$APP_DIR")/.kaki-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  pm2 stop "$PM2_APP_NAME" || true
  mv -- "$APP_DIR" "$rollback_app"; mv -- "$restore_app" "$APP_DIR"
  if ! database_restore "$restore_payload/database"; then
    rm -rf -- "$APP_DIR"; mv -- "$rollback_app" "$APP_DIR"; database_restore "$safety_db" || true; (cd "$APP_DIR" && pm2 restart "$PM2_APP_NAME" --update-env) || true
    die 'Database restore failed; automatic application/database rollback attempted.'
  fi
  (cd "$APP_DIR" && PORT="$PORT" pm2 restart "$PM2_APP_NAME" --update-env && pm2 save --force)
  rm -rf -- "$rollback_app"
  write_state restore success 'Full system restore completed and CRM restarted.' "$BACKUP_ID"
}

case "$COMMAND" in
  create) create_backup "${ARGUMENT:-manual}" "$ACTOR" true ;;
  verify) verify_backup "$ARGUMENT" ;;
  restore) restore_backup "$ARGUMENT" "$ACTOR" ;;
  *) die 'Usage: backup-engine.sh create TRIGGER ACTOR | verify ARCHIVE | restore ARCHIVE ACTOR' ;;
esac

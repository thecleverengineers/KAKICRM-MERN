#!/usr/bin/env bash
# KAKI CRM release deployer.
#
# The release is prepared and built in an isolated directory while the
# currently installed release remains online. A disposable PM2 canary then
# proves that the new process can boot and answer both health and application
# requests. Only after those checks pass is the installed directory switched
# with two same-filesystem renames. If the new process or a post-switch check
# fails, the previous release is restored automatically.
#
# This script never changes MongoDB data and never copies the Google OAuth JSON
# into the application tree. Production .env, server/uploads and the previous
# application directory are preserved.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-/www/kaki}"
UPDATE_ZIP="${UPDATE_ZIP:-}"
GOOGLE_CLIENT_JSON="${GOOGLE_CLIENT_JSON:-}"
APP_ORIGIN="${APP_ORIGIN:-https://www.kakicrm.store,https://kakicrm.store}"
APP_PORT="${APP_PORT:-4000}"
APP_HOST="${APP_HOST:-127.0.0.1}"
HEALTH_HOST="${DEPLOY_HEALTH_HOST:-127.0.0.1}"
PM2_APP_NAME="${PM2_APP_NAME:-kaki-crm}"
RELEASE_VERSION="${RELEASE_VERSION:-unknown}"
EXPECTED_SHA256="${EXPECTED_SHA256:-}"
RELEASE_ROOT="${RELEASE_ROOT:-}"
STAGE_DIR="${STAGE_DIR:-}"
CLEANUP_STAGE="${CLEANUP_STAGE:-false}"
VERIFY_GOOGLE_CLOUD_APIS="${VERIFY_GOOGLE_CLOUD_APIS:-false}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/run/lock/kaki-crm-deploy.lock}"
BACKUP_ROOT="${DEPLOY_BACKUP_ROOT:-/var/backups}"
BACKUP_DIR=""
NEW_APP_DIR=""
CANARY_NAME=""
CANARY_PORT=""
SWAP_STARTED=false
CANARY_STARTED=false
PM2_RELOAD_ATTEMPTED=false
ERROR_LINE=""
ERROR_COMMAND=""

info() { printf '\n[KAKI DEPLOY] %s\n' "$*"; }
die() { printf '\n[KAKI DEPLOY ERROR] %s\n' "$*" >&2; exit 1; }
warn() { printf '\n[KAKI DEPLOY WARNING] %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage: deploy-production-release.sh [options]

Required options:
  --update-zip PATH             Release ZIP on the production host
  --google-client-json PATH     Optional Google Web OAuth JSON (outside app dir)

Optional options:
  --release-version VERSION     Release label for logs
  --app-dir PATH                Installed app directory (default /www/kaki)
  --app-origin ORIGINS          Comma-separated public origins
  --app-port PORT               Private Node port (default 4000)
  --app-host HOST               Private Node host (default 127.0.0.1)
  --pm2-app-name NAME           PM2 process (default kaki-crm)
  --expected-sha256 HASH        Verify the release ZIP before extraction
  --release-root PATH           Already-extracted kaki-crm-modern directory
  --stage-dir PATH              Temporary extraction directory to remove after run
  --cleanup-stage               Remove --stage-dir after the deployment
  --verify-google-cloud-apis    Confirm Calendar, Meet and Drive APIs with gcloud
USAGE
}

while (($# > 0)); do
  case "$1" in
    --release-version)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      RELEASE_VERSION="$2"
      shift 2
      ;;
    --app-dir)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      APP_DIR="$2"
      shift 2
      ;;
    --update-zip)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      UPDATE_ZIP="$2"
      shift 2
      ;;
    --google-client-json)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      GOOGLE_CLIENT_JSON="$2"
      shift 2
      ;;
    --app-origin)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      APP_ORIGIN="$2"
      shift 2
      ;;
    --app-port)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      APP_PORT="$2"
      shift 2
      ;;
    --app-host)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      APP_HOST="$2"
      shift 2
      ;;
    --pm2-app-name)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      PM2_APP_NAME="$2"
      shift 2
      ;;
    --expected-sha256)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --release-root)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      RELEASE_ROOT="$2"
      shift 2
      ;;
    --stage-dir)
      [ "$#" -ge 2 ] || die "Missing value for $1"
      STAGE_DIR="$2"
      shift 2
      ;;
    --cleanup-stage)
      CLEANUP_STAGE=true
      shift
      ;;
    --verify-google-cloud-apis)
      VERIFY_GOOGLE_CLOUD_APIS=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option '$1'. Use --help for usage."
      ;;
  esac
done

cleanup_canary() {
  if [ "$CANARY_STARTED" = true ] && command -v pm2 >/dev/null 2>&1; then
    pm2 delete "$CANARY_NAME" >/dev/null 2>&1 || true
  fi
  CANARY_STARTED=false
}

cleanup_new_app() {
  if [ -n "$NEW_APP_DIR" ] && [ -d "$NEW_APP_DIR" ]; then
    rm -rf -- "$NEW_APP_DIR"
  fi
  NEW_APP_DIR=""
}

cleanup() {
  cleanup_canary
  cleanup_new_app
  if [ "$CLEANUP_STAGE" = true ] && [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf -- "$STAGE_DIR"
  fi
}

read_env_value() {
  local env_file="$1" key="$2"
  (
    cd "$(dirname -- "$env_file")"
    node --input-type=module -e "import { readFileSync } from 'node:fs'; import dotenv from 'dotenv'; const values = dotenv.parse(readFileSync(process.argv[1])); const value = values[process.argv[2]]; if (typeof value !== 'string' || !value) process.exit(2); process.stdout.write(value);" "$env_file" "$key"
  )
}

port_is_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk -v pattern=":$port$" '$4 ~ pattern { found = 1 } END { exit found ? 0 : 1 }'
  else
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -q .
  fi
}

find_free_port() {
  local start="$1" candidate offset
  for ((offset = 0; offset < 50; offset += 1)); do
    candidate=$((start + offset))
    if ((candidate > 65535)); then
      break
    fi
    if ! port_is_in_use "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

wait_for_url() {
  local port="$1" path="$2" attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "http://$HEALTH_HOST:$port$path" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  [ "$SWAP_STARTED" = true ] || return 0
  [ -n "$BACKUP_DIR" ] || return 1

  warn "Deployment failed; restoring the previous application from $BACKUP_DIR"
  if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
    mv -- "$APP_DIR" "$BACKUP_DIR/failed-app" || {
      warn 'Could not move the failed application aside; manual recovery is required.'
      return 1
    }
  fi

  [ -d "$BACKUP_DIR/app" ] || {
    warn "The previous application backup is missing at $BACKUP_DIR/app."
    return 1
  }
  mv -- "$BACKUP_DIR/app" "$APP_DIR" || {
    warn "Could not restore $BACKUP_DIR/app to $APP_DIR."
    return 1
  }

  if [ "$PM2_RELOAD_ATTEMPTED" = true ] && command -v pm2 >/dev/null 2>&1; then
    info 'Reloading PM2 against the restored application'
    local mongo_uri=''
    if mongo_uri="$(read_env_value "$APP_DIR/.env" MONGODB_URI)"; then
      (
        cd "$APP_DIR"
        NODE_ENV=production PORT="$APP_PORT" HOST="$APP_HOST" MONGODB_URI="$mongo_uri" UPLOAD_ROOT="$APP_DIR/server/uploads" CORS_ORIGIN="$APP_ORIGIN" APP_ORIGIN="$APP_ORIGIN" pm2 reload "$PM2_APP_NAME" --update-env
        pm2 save --force
      ) || {
        warn 'The previous application was restored, but PM2 could not be reloaded automatically.'
        return 1
      }
    else
      warn 'MONGODB_URI could not be read from the restored .env; reloading PM2 with its existing database environment.'
      (
        cd "$APP_DIR"
        NODE_ENV=production PORT="$APP_PORT" HOST="$APP_HOST" UPLOAD_ROOT="$APP_DIR/server/uploads" CORS_ORIGIN="$APP_ORIGIN" APP_ORIGIN="$APP_ORIGIN" pm2 reload "$PM2_APP_NAME" --update-env
        pm2 save --force
      ) || {
        warn 'The previous application was restored, but PM2 could not be reloaded automatically.'
        return 1
      }
    fi
  fi
  info 'Previous application restored successfully'
}

on_error() {
  local status="$?"
  ERROR_LINE="${BASH_LINENO[0]:-unknown}"
  ERROR_COMMAND="${BASH_COMMAND:-unknown}"
  trap - ERR
  exit "$status"
}

on_exit() {
  local status="$?"
  trap - EXIT ERR
  if [ "$status" -ne 0 ]; then
    rollback || true
    printf '\nERROR: KAKI CRM %s deployment failed (exit %s).\n' "$RELEASE_VERSION" "$status" >&2
    if [ -n "$ERROR_LINE" ]; then
      printf 'Failed at line %s: %s\n' "$ERROR_LINE" "$ERROR_COMMAND" >&2
    fi
    if [ -n "$BACKUP_DIR" ]; then
      printf 'Backup retained at: %s\n' "$BACKUP_DIR" >&2
    fi
  elif [ -n "$BACKUP_DIR" ]; then
    printf 'Previous release backup retained at: %s\n' "$BACKUP_DIR"
  fi
  cleanup || true
  exit "$status"
}

trap on_error ERR
trap on_exit EXIT

require_file() {
  [ -f "$1" ] || die "Required file not found: $1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_command unzip
require_command sha256sum
require_command bash
require_command flock
require_command mktemp
require_command stat
require_command curl
require_command node
require_command npm
require_command pm2
if ! command -v ss >/dev/null 2>&1 && ! command -v lsof >/dev/null 2>&1; then
  die 'Either ss or lsof is required to select a safe canary port.'
fi

[[ "$RELEASE_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || die 'RELEASE_VERSION may contain only letters, numbers, dots, underscores and hyphens.'
[[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "APP_PORT must be numeric: $APP_PORT"
((APP_PORT >= 1 && APP_PORT <= 65534)) || die "APP_PORT must be between 1 and 65534: $APP_PORT"

[ -d "$APP_DIR" ] || die "Application directory does not exist: $APP_DIR"
require_file "$APP_DIR/.env"
require_file "$UPDATE_ZIP"
[ -n "$RELEASE_ROOT" ] || die 'The extracted release root is required (--release-root).'
[ -d "$RELEASE_ROOT" ] || die "Release root does not exist: $RELEASE_ROOT"
[ "$RELEASE_ROOT" != "$APP_DIR" ] || die 'The release root must not be the installed application directory.'
require_file "$RELEASE_ROOT/package.json"
require_file "$RELEASE_ROOT/update-production-pm2.sh"
require_file "$RELEASE_ROOT/scripts/configure-google-oauth.sh"
require_file "$RELEASE_ROOT/scripts/verify-google-meet-production.sh"
require_file "$RELEASE_ROOT/scripts/verify-google-cloud-apis.sh"
require_file "$RELEASE_ROOT/scripts/install-backup-system.sh"
require_file "$RELEASE_ROOT/scripts/backup-engine.sh"
require_file "$RELEASE_ROOT/scripts/mongodb-portable-backup.mjs"
require_file "$RELEASE_ROOT/scripts/google-drive-backup.mjs"

# Refuse an archive that would overwrite production secrets or runtime data.
[ ! -e "$RELEASE_ROOT/.env" ] || die 'Release contains .env; refusing to overwrite production configuration.'
[ ! -e "$RELEASE_ROOT/server/uploads" ] || die 'Release contains server/uploads; refusing to overwrite uploaded files.'

if [ -n "$EXPECTED_SHA256" ]; then
  printf '%s  %s\n' "$EXPECTED_SHA256" "$UPDATE_ZIP" | sha256sum -c -
fi

GOOGLE_JSON_AVAILABLE=false
if [ -n "$GOOGLE_CLIENT_JSON" ] && [ -f "$GOOGLE_CLIENT_JSON" ]; then
  GOOGLE_JSON_AVAILABLE=true
elif [ -n "$GOOGLE_CLIENT_JSON" ]; then
  warn "Google OAuth JSON not found at $GOOGLE_CLIENT_JSON; preserving the existing OAuth configuration."
else
  info 'No Google OAuth JSON supplied; preserving the existing .env/CEO-managed OAuth configuration.'
fi

install -d -m 0755 "$(dirname -- "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die 'Another KAKI CRM deployment is already running.'

pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1 || die "PM2 process $PM2_APP_NAME was not found. Use install-production-pm2.sh for the first installation."
info 'Confirming the current release is healthy before preparation'
wait_for_url "$APP_PORT" /api/health || die 'The current release is not healthy; deployment stopped before changing it.'

if [ ! -d "$BACKUP_ROOT" ]; then
  install -d -m 0700 "$BACKUP_ROOT"
fi
[ "$(stat -c '%d' "$APP_DIR")" = "$(stat -c '%d' "$BACKUP_ROOT")" ] || die "Backup root $BACKUP_ROOT must be on the same filesystem as $APP_DIR."

info "Preparing $RELEASE_VERSION while the current release remains online"
cp -p "$APP_DIR/.env" "$RELEASE_ROOT/.env"

if [ "$GOOGLE_JSON_AVAILABLE" = true ]; then
  info 'Loading the Google Web OAuth client into the staged protected .env'
  APP_DIR="$RELEASE_ROOT" \
  APP_ORIGIN="$APP_ORIGIN" \
  GOOGLE_CLIENT_JSON="$GOOGLE_CLIENT_JSON" \
  bash "$RELEASE_ROOT/scripts/configure-google-oauth.sh"
else
  info 'Skipping Google OAuth import; existing OAuth configuration is preserved in the staged .env.'
fi

info 'Installing dependencies, type-checking and building the isolated release'
PREPARE_ONLY=true \
APP_DIR="$RELEASE_ROOT" \
APP_PORT="$APP_PORT" \
APP_HOST="$APP_HOST" \
APP_ORIGIN="$APP_ORIGIN" \
PM2_APP_NAME="$PM2_APP_NAME" \
bash "$RELEASE_ROOT/update-production-pm2.sh"

if [ "$VERIFY_GOOGLE_CLOUD_APIS" = true ]; then
  info 'Confirming Google Calendar, Meet and Drive APIs in the staged release'
  APP_DIR="$RELEASE_ROOT" \
  GOOGLE_CLIENT_JSON="$GOOGLE_CLIENT_JSON" \
  bash "$RELEASE_ROOT/scripts/verify-google-cloud-apis.sh"
fi

CANARY_PORT="$(find_free_port "$((APP_PORT + 1))")" || die 'Could not find a free local port for the release canary.'
CANARY_NAME="$PM2_APP_NAME-canary-$RELEASE_VERSION"
local_mongo_uri=''
local_mongo_uri="$(read_env_value "$RELEASE_ROOT/.env" MONGODB_URI)" || die 'MONGODB_URI is missing from the staged .env.'

info "Starting isolated PM2 canary $CANARY_NAME on $HEALTH_HOST:$CANARY_PORT"
NODE_ENV=production \
PORT="$CANARY_PORT" \
HOST="$APP_HOST" \
MONGODB_URI="$local_mongo_uri" \
UPLOAD_ROOT="$RELEASE_ROOT/server/uploads" \
CORS_ORIGIN="$APP_ORIGIN" \
APP_ORIGIN="$APP_ORIGIN" \
pm2 start "$RELEASE_ROOT/dist/server/index.js" \
  --name "$CANARY_NAME" \
  --cwd "$RELEASE_ROOT" \
  --interpreter "$(command -v node)" \
  --time \
  --restart-delay 5000 \
  --max-memory-restart 500M
CANARY_STARTED=true

if ! wait_for_url "$CANARY_PORT" /api/health; then
  pm2 logs "$CANARY_NAME" --lines 80 --nostream || true
  die 'The isolated release canary did not become healthy.'
fi
if ! wait_for_url "$CANARY_PORT" /; then
  pm2 logs "$CANARY_NAME" --lines 80 --nostream || true
  die 'The isolated release canary could not serve the application shell.'
fi
cleanup_canary
info 'Release canary passed health and application-shell checks.'

APP_PARENT="$(dirname -- "$APP_DIR")"
NEW_APP_DIR="$(mktemp -d "$APP_PARENT/.kaki-release-$RELEASE_VERSION.XXXXXX")"
info "Copying the verified release into $NEW_APP_DIR"
cp -a "$RELEASE_ROOT/." "$NEW_APP_DIR/"
install -d -m 0755 "$NEW_APP_DIR/server"
if [ -d "$APP_DIR/server/uploads" ]; then
  cp -a "$APP_DIR/server/uploads" "$NEW_APP_DIR/server/uploads"
else
  install -d -m 0755 "$NEW_APP_DIR/server/uploads"
fi
chmod 700 \
  "$NEW_APP_DIR/update-production-pm2.sh" \
  "$NEW_APP_DIR/scripts/configure-google-oauth.sh" \
  "$NEW_APP_DIR/scripts/verify-google-meet-production.sh" \
  "$NEW_APP_DIR/scripts/verify-google-cloud-apis.sh" \
  "$NEW_APP_DIR/scripts/deploy-production-release.sh" \
  "$NEW_APP_DIR/scripts/install-backup-system.sh" \
  "$NEW_APP_DIR/scripts/backup-engine.sh" \
  "$NEW_APP_DIR/scripts/mongodb-portable-backup.mjs" \
  "$NEW_APP_DIR/scripts/google-drive-backup.mjs"

BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/kaki-crm-$RELEASE_VERSION.XXXXXX")"
info "Switching the verified release with a recoverable backup at $BACKUP_DIR"
mv -- "$APP_DIR" "$BACKUP_DIR/app"
SWAP_STARTED=true
mv -- "$NEW_APP_DIR" "$APP_DIR"
NEW_APP_DIR=""

cd "$APP_DIR"
info 'Installing the encrypted backup vault and 5:30 PM Asia/Kolkata timer'
APP_DIR="$APP_DIR" PM2_APP_NAME="$PM2_APP_NAME" bash scripts/install-backup-system.sh
local_mongo_uri="$(read_env_value "$APP_DIR/.env" MONGODB_URI)" || die 'MONGODB_URI is missing from the installed .env.'
info "Gracefully reloading PM2 process $PM2_APP_NAME"
PM2_RELOAD_ATTEMPTED=true
NODE_ENV=production \
PORT="$APP_PORT" \
HOST="$APP_HOST" \
MONGODB_URI="$local_mongo_uri" \
UPLOAD_ROOT="$APP_DIR/server/uploads" \
CORS_ORIGIN="$APP_ORIGIN" \
APP_ORIGIN="$APP_ORIGIN" \
pm2 reload "$PM2_APP_NAME" --update-env

if ! wait_for_url "$APP_PORT" /api/health; then
  pm2 logs "$PM2_APP_NAME" --lines 80 --nostream || true
  die 'The new PM2 process did not become healthy after the switch.'
fi
if ! wait_for_url "$APP_PORT" /; then
  pm2 logs "$PM2_APP_NAME" --lines 80 --nostream || true
  die 'The new PM2 process could not serve the application shell after the switch.'
fi
pm2 save --force

info 'Running the read-only Google Meet production check'
IFS=',' read -r CALLBACK_ORIGIN _ <<< "$APP_ORIGIN"
CALLBACK_ORIGIN="$(printf '%s' "$CALLBACK_ORIGIN" | sed 's:/$::')"
APP_DIR="$APP_DIR" \
APP_PORT="$APP_PORT" \
PM2_APP_NAME="$PM2_APP_NAME" \
EXPECTED_CALLBACK="$CALLBACK_ORIGIN/api/integrations/google/callback" \
bash scripts/verify-google-meet-production.sh

info 'Final health check'
curl --fail --silent --show-error "http://$HEALTH_HOST:$APP_PORT/api/health"
printf '\n'
pm2 status "$PM2_APP_NAME"
printf '\nKAKI CRM %s deployed successfully.\n' "$RELEASE_VERSION"

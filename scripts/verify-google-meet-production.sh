#!/usr/bin/env bash
# Read-only production check for the Google Calendar/Meet integration.
# It never prints OAuth secrets and never changes MongoDB, .env or PM2 state.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-/www/kaki}"
APP_PORT="${APP_PORT:-4000}"
APP_NAME="${PM2_APP_NAME:-kaki-crm}"
EXPECTED_CALLBACK="${EXPECTED_CALLBACK:-https://www.kakicrm.store/api/integrations/google/callback}"

die() { printf '\n[KAKI GOOGLE CHECK ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[KAKI GOOGLE CHECK] %s\n' "$*"; }
warn() { printf '[KAKI GOOGLE CHECK WARNING] %s\n' "$*" >&2; }

[ -d "$APP_DIR" ] || die "Application directory not found: $APP_DIR"
[ -f "$APP_DIR/.env" ] || die "Missing production environment: $APP_DIR/.env"
command -v node >/dev/null 2>&1 || die 'Node.js is required.'
command -v pm2 >/dev/null 2>&1 || die 'PM2 is required.'
command -v curl >/dev/null 2>&1 || die 'curl is required.'

read_env() {
  node --input-type=module - "$APP_DIR/.env" "$1" <<'NODE'
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
const values = dotenv.parse(readFileSync(process.argv[2]));
const value = values[process.argv[3]];
if (typeof value === 'string' && value.trim()) process.stdout.write(value.trim());
NODE
}

client_id="$(read_env GOOGLE_CLIENT_ID || true)"
redirect_uri="$(read_env GOOGLE_OAUTH_REDIRECT_URI || true)"
app_origin="$(read_env APP_ORIGIN || true)"

if [ -n "$client_id" ]; then
  case "$client_id" in
    *.apps.googleusercontent.com) info "OAuth client ID is present (${client_id})." ;;
    *) warn 'GOOGLE_CLIENT_ID is present but does not look like a Google Web client ID.' ;;
  esac
else
  warn 'GOOGLE_CLIENT_ID is not in .env. CEO-managed OAuth settings may be stored in MongoDB; otherwise run scripts/configure-google-oauth.sh once.'
fi

if [ -n "$redirect_uri" ] && [ "$redirect_uri" != "$EXPECTED_CALLBACK" ]; then
  die "GOOGLE_OAUTH_REDIRECT_URI must be exactly ${EXPECTED_CALLBACK}; found ${redirect_uri}"
fi
if [ -n "$app_origin" ]; then
  case ",${app_origin}," in
    *,https://www.kakicrm.store,*|*,https://kakicrm.store,*) ;;
    *) warn "APP_ORIGIN does not include the canonical production origin: ${app_origin}" ;;
  esac
fi

pm2 describe "$APP_NAME" >/dev/null 2>&1 || die "PM2 process '${APP_NAME}' was not found."
health=''
for attempt in $(seq 1 10); do
  health="$(curl --fail --silent --show-error "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || true)"
  [ -n "$health" ] && break
  sleep 1
done
[ -n "$health" ] || die "Health endpoint is unavailable at 127.0.0.1:${APP_PORT}."
info "Health endpoint: ${health}"
info "PM2 process '${APP_NAME}' is online and serving port ${APP_PORT}."
info "For a provider-level check, open Meetings → Test connection while signed in as an authorised meeting manager."

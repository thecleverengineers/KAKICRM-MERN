#!/usr/bin/env bash
# Safe KAKI CRM application updater — no Docker, no MongoDB data changes.
#
# Run from the installed application directory:
#   APP_DIR=/www/kaki APP_NAME=kaki-crm bash update-production-pm2.sh
#
# This script deliberately preserves .env, server/uploads, and all MongoDB data.
# It validates and builds the release before asking PM2 to reload it.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-$(pwd)}"
APP_NAME="${PM2_APP_NAME:-${APP_NAME:-kaki-crm}}"
APP_PORT="${APP_PORT:-4000}"
APP_HOST="${APP_HOST:-127.0.0.1}"
APP_ORIGIN="${APP_ORIGIN:-}"
PREPARE_ONLY="${PREPARE_ONLY:-false}"

info() { printf '\n[KAKI] %s\n' "$*"; }
die() { printf '\n[KAKI ERROR] %s\n' "$*" >&2; exit 1; }

require_file() {
  [ -f "$1" ] || die "Required file not found: $1"
}

set_env_value() {
  local key="$1" value="$2" escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$APP_DIR/.env"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}

read_env_value() {
  local key="$1"
  (
    cd "$APP_DIR"
    node --input-type=module -e "import { readFileSync } from 'node:fs'; import dotenv from 'dotenv'; const values = dotenv.parse(readFileSync(process.argv[1])); const value = values[process.argv[2]]; if (typeof value !== 'string' || !value) process.exit(2); process.stdout.write(value);" "$APP_DIR/.env" "$key"
  )
}

node_is_supported() {
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)"
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if curl --fail --silent --show-error "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

main() {
  [ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR"
  require_file "$APP_DIR/package.json"
  require_file "$APP_DIR/.env"
  command -v node >/dev/null 2>&1 || die 'Node.js is required.'
  command -v npm >/dev/null 2>&1 || die 'npm is required.'
  if [ "$PREPARE_ONLY" != true ]; then
    command -v pm2 >/dev/null 2>&1 || die 'PM2 is required. Run install-production-pm2.sh once first.'
  fi
  node_is_supported || die "Node.js $(node --version) is too old. Node.js 20.11 or newer is required."

  # Keep the saved .env and PM2 runtime environment on the same private port.
  # Otherwise a stale PM2 PORT value can make the app bind elsewhere while the
  # health check (and Nginx) correctly expects APP_PORT.
  set_env_value PORT "$APP_PORT"
  set_env_value HOST "$APP_HOST"

  if [ -n "$APP_ORIGIN" ]; then
    info "Setting browser origin to ${APP_ORIGIN}"
    set_env_value CORS_ORIGIN "$APP_ORIGIN"
    # Keep the public origin available to OAuth callback redirects. This is
    # separate from CORS so callback redirects never fall back to localhost.
    set_env_value APP_ORIGIN "$APP_ORIGIN"
  fi

  info 'Installing the locked dependencies'
  (
    cd "$APP_DIR"
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
  )

  info 'Type-checking and building the release'
  (
    cd "$APP_DIR"
    npm run check
    npm run build
  )

  if [ "$PREPARE_ONLY" = true ]; then
    info 'Release prepared successfully. PM2 was not changed.'
    return 0
  fi

  pm2 describe "$APP_NAME" >/dev/null 2>&1 || die "PM2 process '${APP_NAME}' was not found. Use install-production-pm2.sh for the first installation."
  # PM2 retains prior process variables. Always pass the URI from the preserved
  # .env so a stale PM2 MONGODB_URI cannot make the new app authenticate
  # against an empty or different database.
  local mongo_uri
  mongo_uri="$(read_env_value MONGODB_URI)" || die 'MONGODB_URI is missing from .env.'
  info "Reloading PM2 process '${APP_NAME}'"
  PORT="$APP_PORT" HOST="$APP_HOST" MONGODB_URI="$mongo_uri" UPLOAD_ROOT="$APP_DIR/server/uploads" pm2 reload "$APP_NAME" --update-env
  pm2 save --force

  info 'Waiting for application health'
  wait_for_health || {
    pm2 logs "$APP_NAME" --lines 80 --nostream || true
    die 'The PM2 process reloaded, but the health endpoint is not ready.'
  }
  info 'Update completed. MongoDB records, .env, and uploaded files were not changed.'
}

main "$@"

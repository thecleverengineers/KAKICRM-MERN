#!/usr/bin/env bash
# Read-only Google Cloud API check for Calendar, Meet and Drive integration.
#
# The CRM cannot enable Google Cloud services on your behalf. This helper uses
# the authenticated gcloud account to verify that the OAuth client's project
# has all required APIs enabled, without changing the project or printing a
# client secret.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-/www/kaki}"
GOOGLE_CLIENT_JSON="${GOOGLE_CLIENT_JSON:-${1:-}}"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT_ID:-}"

die() { printf '\n[KAKI GOOGLE CLOUD ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[KAKI GOOGLE CLOUD] %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: verify-google-cloud-apis.sh [options]

Options:
  --project PROJECT_ID       Google Cloud project to inspect
  --client-json PATH         Web/installed OAuth JSON; reads only project_id
  --app-dir PATH             App directory whose .env may provide the project ID
  --help                     Show this help

Examples:
  GOOGLE_CLIENT_JSON=/root/client_secret.json bash scripts/verify-google-cloud-apis.sh
  bash scripts/verify-google-cloud-apis.sh --project my-project-id
USAGE
}

while (($# > 0)); do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || die 'Missing value for --project.'
      PROJECT_ID="$2"
      shift 2
      ;;
    --client-json)
      [ "$#" -ge 2 ] || die 'Missing value for --client-json.'
      GOOGLE_CLIENT_JSON="$2"
      shift 2
      ;;
    --app-dir)
      [ "$#" -ge 2 ] || die 'Missing value for --app-dir.'
      APP_DIR="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      die "Unknown option '$1'."
      ;;
    *)
      [ -z "$GOOGLE_CLIENT_JSON" ] || die "Unexpected argument '$1'."
      GOOGLE_CLIENT_JSON="$1"
      shift
      ;;
  esac
done

read_env_project() {
  [ -f "$APP_DIR/.env" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node --input-type=module - "$APP_DIR/.env" <<'NODE'
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
const values = dotenv.parse(readFileSync(process.argv[2]));
const project = values.GOOGLE_CLOUD_PROJECT_ID;
if (typeof project === 'string' && project.trim()) process.stdout.write(project.trim());
NODE
}

read_json_project() {
  [ -f "$GOOGLE_CLIENT_JSON" ] || die "Google OAuth JSON not found: $GOOGLE_CLIENT_JSON"
  command -v node >/dev/null 2>&1 || die 'Node.js is required to read project_id from the OAuth JSON.'
  node --input-type=module - "$GOOGLE_CLIENT_JSON" <<'NODE'
import { readFileSync } from 'node:fs';
const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const client = document.web ?? document.installed;
const project = client && typeof client === 'object' && typeof client.project_id === 'string' ? client.project_id.trim() : '';
if (project) process.stdout.write(project);
NODE
}

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="$(read_env_project || true)"
fi
if [ -z "$PROJECT_ID" ] && [ -n "$GOOGLE_CLIENT_JSON" ]; then
  PROJECT_ID="$(read_json_project || true)"
fi
[ -n "$PROJECT_ID" ] || die 'Provide --project, GOOGLE_CLOUD_PROJECT_ID, or --client-json with project_id.'

command -v gcloud >/dev/null 2>&1 || die 'gcloud is required. Install the Google Cloud CLI, authenticate it, then run this read-only check again.'
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
[ -n "$active_account" ] || die 'No active gcloud account is available. Run gcloud auth login with a user that can view services in this project.'

info "Inspecting enabled services in project ${PROJECT_ID}."
enabled="$(gcloud --quiet --project="$PROJECT_ID" services list --enabled --format='value(config.name)' 2>/dev/null)" || die "Could not list enabled services for ${PROJECT_ID}. Check the active account and project IAM permissions."

missing=()
for service in calendar-json.googleapis.com meet.googleapis.com drive.googleapis.com; do
  if printf '%s\n' "$enabled" | grep -Fxq "$service"; then
    info "${service}: ENABLED"
  else
    info "${service}: MISSING"
    missing+=("$service")
  fi
done

if ((${#missing[@]} > 0)); then
  printf '\nEnable the missing services, then run this check again:\n  gcloud services enable %s --project=%q\n' "${missing[*]}" "$PROJECT_ID" >&2
  exit 1
fi

info 'Google Calendar API, Google Meet REST API and Google Drive API are enabled.'

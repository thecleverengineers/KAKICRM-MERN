#!/usr/bin/env bash
# Load a Google OAuth Web client JSON into the deployment .env without ever
# copying the credential into the release tree. Run once on the production
# server, then keep the same .env for all future application updates.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-/www/kaki}"
GOOGLE_CLIENT_JSON="${GOOGLE_CLIENT_JSON:-${1:-}}"
PUBLIC_ORIGIN="${APP_ORIGIN:-https://www.kakicrm.store,https://kakicrm.store}"

die() { printf '\n[KAKI OAUTH ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '\n[KAKI OAUTH] %s\n' "$*"; }

[ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR"
[ -f "$APP_DIR/.env" ] || die "Missing $APP_DIR/.env; create the production environment first."
[ -n "$GOOGLE_CLIENT_JSON" ] || die "Set GOOGLE_CLIENT_JSON to the uploaded client_secret_*.json path."
[ -f "$GOOGLE_CLIENT_JSON" ] || die "Google client JSON not found: $GOOGLE_CLIENT_JSON"
command -v node >/dev/null 2>&1 || die 'Node.js is required.'

set_env_value() {
  local key="$1" value="$2" escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$APP_DIR/.env"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}

mapfile -t oauth_values < <(node --input-type=module - "$GOOGLE_CLIENT_JSON" <<'NODE'
import { readFileSync } from 'node:fs';

const file = process.argv.at(-1);
const document = JSON.parse(readFileSync(file, 'utf8'));
const client = document.web ?? document.installed;
if (!client || typeof client !== 'object') throw new Error('The JSON does not contain a web or installed OAuth client.');
const clientId = typeof client.client_id === 'string' ? client.client_id.trim() : '';
const clientSecret = typeof client.client_secret === 'string' ? client.client_secret.trim() : '';
const projectId = typeof client.project_id === 'string' ? client.project_id.trim() : '';
if (!clientId || !clientSecret) throw new Error('The OAuth JSON is missing client_id or client_secret.');
process.stdout.write(`${clientId}\n${clientSecret}\n${projectId}\n`);
NODE
)

GOOGLE_CLIENT_ID_VALUE="${oauth_values[0]:-}"
GOOGLE_CLIENT_SECRET_VALUE="${oauth_values[1]:-}"
GOOGLE_PROJECT_ID_VALUE="${oauth_values[2]:-}"
[ -n "$GOOGLE_CLIENT_ID_VALUE" ] || die 'The OAuth JSON did not provide a client ID.'
[ -n "$GOOGLE_CLIENT_SECRET_VALUE" ] || die 'The OAuth JSON did not provide a client secret.'

# Only the first origin is used for the browser callback. Keep both canonical
# hostnames in CORS_ORIGIN when the caller supplies both.
CALLBACK_ORIGIN="${PUBLIC_ORIGIN%%,*}"
CALLBACK_ORIGIN="${CALLBACK_ORIGIN%/}"
case "$CALLBACK_ORIGIN" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) die 'APP_ORIGIN must be an https production origin or a localhost development origin.' ;;
esac
GOOGLE_CALLBACK_URI="${CALLBACK_ORIGIN}/api/integrations/google/callback"

set_env_value GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID_VALUE"
set_env_value GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET_VALUE"
set_env_value GOOGLE_OAUTH_REDIRECT_URI "$GOOGLE_CALLBACK_URI"
[ -n "$GOOGLE_PROJECT_ID_VALUE" ] && set_env_value GOOGLE_CLOUD_PROJECT_ID "$GOOGLE_PROJECT_ID_VALUE"
set_env_value APP_ORIGIN "$PUBLIC_ORIGIN"
chmod 600 "$APP_DIR/.env"

if ! grep -q '^GOOGLE_TOKEN_ENCRYPTION_KEY=.' "$APP_DIR/.env"; then
  command -v openssl >/dev/null 2>&1 || die 'openssl is required to create GOOGLE_TOKEN_ENCRYPTION_KEY.'
  set_env_value GOOGLE_TOKEN_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  info 'Created a stable token-encryption key in .env.'
fi

info "Saved OAuth client ${GOOGLE_CLIENT_ID_VALUE} to .env."
info "Configured callback: ${GOOGLE_CALLBACK_URI}"
info 'The client secret was not printed or copied into the application release.'
info 'Register the exact callback above in Google Cloud Console before connecting Google.'

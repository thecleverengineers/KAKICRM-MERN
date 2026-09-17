#!/usr/bin/env bash
# KAKI CRM production installer — no Docker
#
# In auto mode, uses an already-installed compatible MongoDB server (4.2+) on
# port 27017, including MongoDB 8.x. If MongoDB is missing or too old, it
# installs an isolated MongoDB 7 service on 127.0.0.1:27018 instead.
# It never upgrades, stops, or alters an existing MongoDB server.
#
# Run as root from the application directory:
#   APP_DIR=/www/kaki bash install-production-pm2.sh
#
# Optional settings:
#   APP_ORIGIN=https://www.kakicrm.store,https://kakicrm.store APP_DIR=/www/kaki bash install-production-pm2.sh
#   MONGO_MODE=existing EXISTING_MONGO_PORT=27017 bash install-production-pm2.sh
#   MONGO_MODE=existing EXISTING_MONGODB_URI='mongodb://user:password@127.0.0.1:27017/kaki_crm_modern?authSource=admin' bash install-production-pm2.sh
#   MONGO_MODE=isolated MONGO_PORT=27018 MONGO_VERSION=7.0.39 bash install-production-pm2.sh

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-$(pwd)}"
APP_NAME="${PM2_APP_NAME:-kaki-crm}"
APP_PORT="${APP_PORT:-4000}"
APP_ORIGIN="${APP_ORIGIN:-https://www.kakicrm.store,https://kakicrm.store}"
MONGO_MODE="${MONGO_MODE:-auto}"
EXISTING_MONGO_PORT="${EXISTING_MONGO_PORT:-27017}"
EXISTING_MONGODB_URI="${EXISTING_MONGODB_URI:-}"
MONGO_PORT="${MONGO_PORT:-27018}"
MONGO_DB="${MONGO_DB:-kaki_crm_modern}"
MONGO_VERSION="${MONGO_VERSION:-7.0.39}"
MONGO_PLATFORM="${MONGO_PLATFORM:-}"
MONGO_USER="${MONGO_SERVICE_USER:-kaki-crm-mongo}"
MONGO_GROUP="${MONGO_SERVICE_GROUP:-$MONGO_USER}"
MONGO_APP_USER="${MONGO_APP_USER:-kaki_crm_app}"
MONGO_ROOT="${MONGO_ROOT:-/opt/kaki-crm}"
MONGO_DATA_DIR="${MONGO_DATA_DIR:-/var/lib/kaki-crm-mongodb}"
MONGO_LOG_DIR="${MONGO_LOG_DIR:-/var/log/kaki-crm-mongodb}"
MONGO_CONFIG_DIR="${MONGO_CONFIG_DIR:-/etc/kaki-crm}"
MONGO_CONFIG="${MONGO_CONFIG_DIR}/mongod.conf"
MONGO_SERVICE="${MONGO_SERVICE:-kaki-crm-mongod}"
PM2_HOME="${PM2_HOME:-/root/.pm2}"
ENV_FILE="${APP_DIR}/.env"
TMP_DIR=""
ACTIVE_MONGO_MODE=""
ACTIVE_MONGO_URI=""

info() { printf '\n[KAKI] %s\n' "$*"; }
warn() { printf '\n[KAKI WARNING] %s\n' "$*" >&2; }
die() { printf '\n[KAKI ERROR] %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Run this installer as root."
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemd is required to keep the isolated MongoDB service running."
  systemctl show-environment >/dev/null 2>&1 || die "systemd is not active on this server."
}

require_file() {
  [ -f "$1" ] || die "Required file not found: $1"
}

is_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 1
}

wait_for_port() {
  local port="$1"
  local attempts="${2:-30}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if is_port_in_use "$port"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"

  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

random_hex() {
  node -e "console.log(require('node:crypto').randomBytes($1).toString('hex'))"
}

node_is_supported() {
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)"
}

mongo_server_version() {
  command -v mongod >/dev/null 2>&1 || return 1
  mongod --version 2>/dev/null | awk '/db version/ { for (i = 1; i <= NF; i += 1) { if ($i ~ /^v?[0-9]+\.[0-9]+\.[0-9]+$/) { sub(/^v/, "", $i); print $i; exit } } }'
}

version_at_least() {
  local actual="$1"
  local required="$2"
  local -a actual_parts required_parts
  local i actual_part required_part

  IFS='.' read -r -a actual_parts <<< "$actual"
  IFS='.' read -r -a required_parts <<< "$required"

  for ((i = 0; i < 3; i += 1)); do
    actual_part="${actual_parts[i]:-0}"
    required_part="${required_parts[i]:-0}"
    if ((10#$actual_part > 10#$required_part)); then
      return 0
    fi
    if ((10#$actual_part < 10#$required_part)); then
      return 1
    fi
  done
  return 0
}

select_mongo_mode() {
  local installed_version
  installed_version="$(mongo_server_version || true)"

  case "$MONGO_MODE" in
    existing)
      [ -n "$installed_version" ] || die "MONGO_MODE=existing was requested, but mongod is not installed."
      version_at_least "$installed_version" '4.2.0' || die "MongoDB ${installed_version} is too old. MongoDB 4.2 or newer is required."
      printf '%s\n' 'existing'
      ;;
    isolated)
      printf '%s\n' 'isolated'
      ;;
    auto)
      if [ -n "$installed_version" ] && version_at_least "$installed_version" '4.2.0'; then
        printf '%s\n' 'existing'
      else
        printf '%s\n' 'isolated'
      fi
      ;;
    *)
      die "Invalid MONGO_MODE '${MONGO_MODE}'. Use auto, existing, or isolated."
      ;;
  esac
}

detect_mongo_platform() {
  if [ -n "$MONGO_PLATFORM" ]; then
    printf '%s\n' "$MONGO_PLATFORM"
    return
  fi

  require_file /etc/os-release
  # shellcheck disable=SC1091
  . /etc/os-release

  case "${ID:-}" in
    ubuntu)
      case "${VERSION_ID:-}" in
        20.04) printf '%s\n' 'ubuntu2004' ;;
        22.04) printf '%s\n' 'ubuntu2204' ;;
        *) die "Unsupported Ubuntu version ${VERSION_ID:-unknown}. Set MONGO_PLATFORM explicitly after selecting a matching MongoDB archive." ;;
      esac
      ;;
    debian)
      case "${VERSION_ID:-}" in
        11) printf '%s\n' 'debian11' ;;
        12) printf '%s\n' 'debian12' ;;
        *) die "Unsupported Debian version ${VERSION_ID:-unknown}. Set MONGO_PLATFORM explicitly after selecting a matching MongoDB archive." ;;
      esac
      ;;
    *)
      die "Unsupported operating system ${ID:-unknown}. This installer supports Ubuntu 20.04/22.04 and Debian 11/12."
      ;;
  esac
}

ensure_download_tools() {
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    return
  fi

  command -v apt-get >/dev/null 2>&1 || die "curl and tar are required. Install them, then run this installer again."
  info "Installing the download prerequisites"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar
}

prepare_app() {
  [ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR"
  require_file "$APP_DIR/package.json"
  require_file "$APP_DIR/tsconfig.server.json"

  command -v node >/dev/null 2>&1 || die "Node.js 20.11 or newer is required."
  command -v npm >/dev/null 2>&1 || die "npm is required."
  node_is_supported || die "Node.js $(node --version) is too old. Install Node.js 20.11 or newer first."

  if [ ! -f "$ENV_FILE" ]; then
    require_file "$APP_DIR/.env.example"
    cp "$APP_DIR/.env.example" "$ENV_FILE"
  fi

  cp -p "$ENV_FILE" "${ENV_FILE}.before-production-install.$(date +%Y%m%d-%H%M%S)"
  set_env_value NODE_ENV production
  set_env_value PORT "$APP_PORT"
  set_env_value HOST 127.0.0.1

  local jwt_secret
  jwt_secret="$(env_value JWT_ACCESS_SECRET)"
  if [ -z "$jwt_secret" ] || [ "$jwt_secret" = 'replace-with-a-long-random-access-secret' ]; then
    set_env_value JWT_ACCESS_SECRET "$(random_hex 48)"
  fi

  if [ -n "$APP_ORIGIN" ]; then
    set_env_value CORS_ORIGIN "$APP_ORIGIN"
  fi

  info "Installing Node.js dependencies and building the production application"
  (
    cd "$APP_DIR"
    if [ -f package-lock.json ]; then
      npm ci
    else
      npm install
    fi
    npm run build
  )
}

install_mongo_binary() {
  ensure_download_tools

  local platform archive url release_dir extracted
  platform="$(detect_mongo_platform)"
  archive="mongodb-linux-x86_64-${platform}-${MONGO_VERSION}.tgz"
  url="${MONGO_DOWNLOAD_URL:-https://fastdl.mongodb.org/linux/${archive}}"
  release_dir="${MONGO_ROOT}/mongodb-${MONGO_VERSION}"

  install -d -m 0755 "$MONGO_ROOT"

  if [ ! -x "${release_dir}/bin/mongod" ]; then
    if [ -e "$release_dir" ]; then
      die "${release_dir} exists but is not a valid MongoDB installation. Move it aside manually before continuing."
    fi

    info "Downloading isolated MongoDB ${MONGO_VERSION} (${platform})"
    TMP_DIR="$(mktemp -d /tmp/kaki-crm-mongo.XXXXXX)"
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --output "${TMP_DIR}/${archive}" "$url" || die "MongoDB download failed: $url"

    tar -xzf "${TMP_DIR}/${archive}" -C "$TMP_DIR"
    extracted="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'mongodb-linux-*' -print -quit)"
    [ -n "$extracted" ] || die "The downloaded MongoDB archive did not contain a server directory."
    [ -x "${extracted}/bin/mongod" ] || die "The downloaded archive does not contain mongod."
    mv "$extracted" "$release_dir"
  fi

  if [ -e "${MONGO_ROOT}/mongodb" ] && [ ! -L "${MONGO_ROOT}/mongodb" ]; then
    die "${MONGO_ROOT}/mongodb exists and is not a symlink. Refusing to replace it."
  fi
  ln -sfn "$release_dir" "${MONGO_ROOT}/mongodb"
}

ensure_mongo_service_account() {
  if ! id -u "$MONGO_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$MONGO_DATA_DIR" --shell /usr/sbin/nologin "$MONGO_USER"
  fi

  MONGO_GROUP="$(id -gn "$MONGO_USER")"

  install -d -o "$MONGO_USER" -g "$MONGO_GROUP" -m 0750 "$MONGO_DATA_DIR"
  install -d -o "$MONGO_USER" -g "$MONGO_GROUP" -m 0750 "$MONGO_LOG_DIR"
  touch "${MONGO_LOG_DIR}/mongod.log"
  chown "$MONGO_USER:$MONGO_GROUP" "${MONGO_LOG_DIR}/mongod.log"
  install -d -m 0755 "$MONGO_CONFIG_DIR"
}

mongo_auth_is_enabled() {
  [ -f "$MONGO_CONFIG" ] && grep -qE '^  authorization: enabled$' "$MONGO_CONFIG"
}

write_mongo_config() {
  local authorization="$1"
  cat > "$MONGO_CONFIG" <<EOF
storage:
  dbPath: ${MONGO_DATA_DIR}
  journal:
    enabled: true
systemLog:
  destination: file
  path: ${MONGO_LOG_DIR}/mongod.log
  logAppend: true
net:
  bindIp: 127.0.0.1
  port: ${MONGO_PORT}
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
security:
  authorization: ${authorization}
EOF
  chmod 0640 "$MONGO_CONFIG"
  chown root:"$MONGO_GROUP" "$MONGO_CONFIG"
}

write_mongo_service() {
  cat > "/etc/systemd/system/${MONGO_SERVICE}.service" <<EOF
[Unit]
Description=KAKI CRM isolated MongoDB
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${MONGO_USER}
Group=${MONGO_GROUP}
ExecStart=${MONGO_ROOT}/mongodb/bin/mongod --config ${MONGO_CONFIG}
ExecStop=/bin/kill -s SIGTERM \$MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=300
LimitNOFILE=64000

[Install]
WantedBy=multi-user.target
EOF
}

start_or_restart_mongo() {
  systemctl daemon-reload
  systemctl enable "$MONGO_SERVICE" >/dev/null
  systemctl restart "$MONGO_SERVICE"
  wait_for_port "$MONGO_PORT" 30 || {
    systemctl --no-pager --full status "$MONGO_SERVICE" || true
    die "The isolated MongoDB service did not start on port ${MONGO_PORT}."
  }
}

create_mongo_user() {
  local password="$1"
  (
    cd "$APP_DIR"
    MONGO_BOOTSTRAP_URI="mongodb://127.0.0.1:${MONGO_PORT}/admin?directConnection=true" \
      MONGO_BOOTSTRAP_DB="$MONGO_DB" \
      MONGO_BOOTSTRAP_USER="$MONGO_APP_USER" \
      MONGO_BOOTSTRAP_PASSWORD="$password" \
      node --input-type=module <<'NODE'
import mongoose from 'mongoose';

const uri = process.env.MONGO_BOOTSTRAP_URI;
const database = process.env.MONGO_BOOTSTRAP_DB;
const username = process.env.MONGO_BOOTSTRAP_USER;
const password = process.env.MONGO_BOOTSTRAP_PASSWORD;

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.getClient().db(database);
const result = await db.command({ usersInfo: { user: username, db: database } });

if (result.users.length > 0) {
  console.error(`A MongoDB user named ${username} already exists in ${database}.`);
  process.exitCode = 42;
} else {
  await db.command({
    createUser: username,
    pwd: password,
    roles: [{ role: 'dbOwner', db: database }]
  });
}

await mongoose.disconnect();
NODE
  )
}

verify_mongo_connection() {
  local uri="$1"
  (
    cd "$APP_DIR"
    MONGO_VERIFY_URI="$uri" node --input-type=module <<'NODE'
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_VERIFY_URI, { serverSelectionTimeoutMS: 10_000 });
await mongoose.connection.db.admin().ping();
await mongoose.disconnect();
NODE
  )
}

configure_existing_mongodb() {
  local current_uri existing_uri installed_version
  installed_version="$(mongo_server_version || true)"
  [ -n "$installed_version" ] || die "No local MongoDB server was found."
  version_at_least "$installed_version" '4.2.0' || die "MongoDB ${installed_version} is too old."
  is_port_in_use "$EXISTING_MONGO_PORT" || die "MongoDB ${installed_version} is installed but is not listening on port ${EXISTING_MONGO_PORT}. Start its service or set EXISTING_MONGO_PORT."

  existing_uri="$EXISTING_MONGODB_URI"
  if [ -z "$existing_uri" ]; then
    current_uri="$(env_value MONGODB_URI)"
    case "$current_uri" in
      "mongodb://127.0.0.1:${EXISTING_MONGO_PORT}/"*|"mongodb://localhost:${EXISTING_MONGO_PORT}/"*)
        existing_uri="$current_uri"
        ;;
      *)
        existing_uri="mongodb://127.0.0.1:${EXISTING_MONGO_PORT}/${MONGO_DB}?directConnection=true"
        ;;
    esac
  fi

  if ! verify_mongo_connection "$existing_uri"; then
    if [ -z "$EXISTING_MONGODB_URI" ]; then
      die "The existing MongoDB server requires authentication. Rerun with EXISTING_MONGODB_URI set to a credentialed connection string for ${MONGO_DB}."
    fi
    die "Unable to authenticate to the existing MongoDB server using EXISTING_MONGODB_URI."
  fi

  set_env_value MONGODB_URI "$existing_uri"
  ACTIVE_MONGO_MODE='existing'
  ACTIVE_MONGO_URI="$existing_uri"
  info "Using the existing compatible MongoDB ${installed_version} service on port ${EXISTING_MONGO_PORT}"
}

configure_isolated_mongodb() {
  ensure_mongo_service_account
  write_mongo_service

  local existing_uri mongo_password mongo_uri
  existing_uri="$(env_value MONGODB_URI)"

  if mongo_auth_is_enabled; then
    if [[ "$existing_uri" != mongodb://*@127.0.0.1:"${MONGO_PORT}"/* ]] && [[ "$existing_uri" != mongodb://*@localhost:"${MONGO_PORT}"/* ]]; then
      die "An existing protected KAKI MongoDB service was found, but .env does not contain its MongoDB URI. Restore the .env backup or set MONGODB_URI before rerunning."
    fi
    info "Using the existing protected KAKI MongoDB service"
    start_or_restart_mongo
    verify_mongo_connection "$existing_uri" || die "Unable to authenticate to the existing KAKI MongoDB service."
    ACTIVE_MONGO_MODE='isolated'
    ACTIVE_MONGO_URI="$existing_uri"
    return
  fi

  if is_port_in_use "$MONGO_PORT" && ! systemctl is-active --quiet "$MONGO_SERVICE"; then
    die "Port ${MONGO_PORT} is already in use by another service. Choose a free MONGO_PORT and rerun."
  fi

  write_mongo_config disabled
  start_or_restart_mongo

  mongo_password="$(random_hex 32)"
  if ! create_mongo_user "$mongo_password"; then
    die "Could not create the KAKI MongoDB application user. No legacy database was changed."
  fi

  mongo_uri="mongodb://${MONGO_APP_USER}:${mongo_password}@127.0.0.1:${MONGO_PORT}/${MONGO_DB}?authSource=${MONGO_DB}"
  write_mongo_config enabled
  start_or_restart_mongo
  verify_mongo_connection "$mongo_uri" || die "The new protected MongoDB service could not be verified."
  set_env_value MONGODB_URI "$mongo_uri"
  ACTIVE_MONGO_MODE='isolated'
  ACTIVE_MONGO_URI="$mongo_uri"
}

configure_pm2() {
  export PM2_HOME
  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing PM2"
    npm install --global pm2@latest
  fi

  local pm2_bin
  pm2_bin="$(command -v pm2)"
  [ -n "$pm2_bin" ] || die "PM2 installation did not complete."

  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  sleep 1
  if is_port_in_use "$APP_PORT"; then
    die "Port ${APP_PORT} is already in use after the old PM2 process stopped. Stop the conflicting process, then rerun this installer."
  fi

  info "Starting KAKI CRM with PM2"
  pm2 start "${APP_DIR}/dist/server/index.js" \
    --name "$APP_NAME" \
    --cwd "$APP_DIR" \
    --interpreter "$(command -v node)" \
    --time \
    --restart-delay 5000 \
    --max-memory-restart 500M

  pm2 save --force
  pm2 startup systemd -u root --hp /root >/dev/null || warn "PM2 started successfully, but automatic startup could not be registered. Run: ${pm2_bin} startup systemd -u root --hp /root"
}

verify_application() {
  local i
  for ((i = 1; i <= 30; i += 1)); do
    if curl --fail --silent --show-error "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  pm2 logs "$APP_NAME" --lines 60 --nostream || true
  return 1
}

main() {
  require_root
  require_systemd
  prepare_app
  ACTIVE_MONGO_MODE="$(select_mongo_mode)"
  if [ "$ACTIVE_MONGO_MODE" = 'existing' ]; then
    configure_existing_mongodb
  else
    install_mongo_binary
    configure_isolated_mongodb
  fi
  configure_pm2

  verify_application || die "PM2 started, but the KAKI CRM health endpoint did not become ready."

  info "Production installation completed successfully."
  printf '%s\n' "- CRM process: PM2 '${APP_NAME}'"
  printf '%s\n' "- CRM health: http://127.0.0.1:${APP_PORT}/api/health"
  if [ "$ACTIVE_MONGO_MODE" = 'existing' ]; then
    printf '%s\n' "- MongoDB: using the existing compatible service on port ${EXISTING_MONGO_PORT}/${MONGO_DB}"
  else
    printf '%s\n' "- New protected MongoDB: 127.0.0.1:${MONGO_PORT}/${MONGO_DB}"
    printf '%s\n' "- New MongoDB data directory: ${MONGO_DATA_DIR}"
  fi
  printf '%s\n' "- No existing MongoDB server was upgraded, stopped, or modified."
  printf '%s\n' "- Public URL: ${APP_ORIGIN%%,*}"
}

main "$@"

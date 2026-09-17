#!/usr/bin/env bash
# Configure KAKI CRM behind the public HTTPS domain without exposing port 4000.
#
# Prerequisites:
#   - kakicrm.store and www.kakicrm.store DNS A records point to this server.
#   - An SSL certificate covering both names has already been issued.
#   - The KAKI CRM PM2 process is installed and listening on 127.0.0.1:4000.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="${APP_DIR:-$(pwd)}"
APP_NAME="${PM2_APP_NAME:-${APP_NAME:-kaki-crm}}"
APP_PORT="${APP_PORT:-4000}"
APP_DOMAIN="${APP_DOMAIN:-www.kakicrm.store}"
APP_APEX_DOMAIN="${APP_APEX_DOMAIN:-kakicrm.store}"
APP_ORIGIN="${APP_ORIGIN:-https://${APP_DOMAIN},https://${APP_APEX_DOMAIN}}"
NGINX_BIN="${NGINX_BIN:-}"
NGINX_CONF="${NGINX_CONF:-}"
SSL_CERT_FILE="${SSL_CERT_FILE:-}"
SSL_KEY_FILE="${SSL_KEY_FILE:-}"
TEMPLATE_FILE="${APP_DIR}/nginx/kakicrm.store.conf.template"
TEMPORARY_CONFIG=""

info() { printf '\n[KAKI] %s\n' "$*"; }
die() { printf '\n[KAKI ERROR] %s\n' "$*" >&2; exit 1; }

set_env_value() {
  local key="$1" value="$2" escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|]/\\&/g')"
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$APP_DIR/.env"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}

choose_nginx() {
  if [ -n "$NGINX_BIN" ]; then
    [ -x "$NGINX_BIN" ] || die "NGINX_BIN is not executable: $NGINX_BIN"
    return
  fi
  if [ -x /www/server/nginx/sbin/nginx ]; then
    NGINX_BIN=/www/server/nginx/sbin/nginx
  elif command -v nginx >/dev/null 2>&1; then
    NGINX_BIN="$(command -v nginx)"
  else
    die 'Nginx was not found. Install/configure Nginx or provide NGINX_BIN.'
  fi
}

choose_config_path() {
  if [ -n "$NGINX_CONF" ]; then
    return
  fi

  local candidate
  if [ -d /www/server/panel/vhost/nginx ]; then
    # aaPanel creates the original site vhost using the first/root domain.
    # Prefer that existing file so an old `kakicrm.store` block cannot keep
    # winning the hostname match and return aaPanel's 403 page.
    for candidate in \
      "/www/server/panel/vhost/nginx/${APP_APEX_DOMAIN}.conf" \
      "/www/server/panel/vhost/nginx/${APP_DOMAIN}.conf"; do
      if [ -f "$candidate" ]; then
        NGINX_CONF="$candidate"
        return
      fi
    done
    NGINX_CONF="/www/server/panel/vhost/nginx/${APP_APEX_DOMAIN}.conf"
  elif [ -d /etc/nginx/sites-available ]; then
    for candidate in \
      "/etc/nginx/sites-available/${APP_APEX_DOMAIN}.conf" \
      "/etc/nginx/sites-available/${APP_DOMAIN}.conf"; do
      if [ -f "$candidate" ]; then
        NGINX_CONF="$candidate"
        return
      fi
    done
    NGINX_CONF="/etc/nginx/sites-available/${APP_APEX_DOMAIN}.conf"
  elif [ -d /etc/nginx/conf.d ]; then
    for candidate in \
      "/etc/nginx/conf.d/${APP_APEX_DOMAIN}.conf" \
      "/etc/nginx/conf.d/${APP_DOMAIN}.conf"; do
      if [ -f "$candidate" ]; then
        NGINX_CONF="$candidate"
        return
      fi
    done
    NGINX_CONF="/etc/nginx/conf.d/${APP_APEX_DOMAIN}.conf"
  else
    die 'Could not find an Nginx virtual-host directory. Provide NGINX_CONF with the exact vhost file path.'
  fi
}

choose_certificate() {
  if [ -n "$SSL_CERT_FILE" ] || [ -n "$SSL_KEY_FILE" ]; then
    [ -f "$SSL_CERT_FILE" ] || die "SSL_CERT_FILE was not found: $SSL_CERT_FILE"
    [ -f "$SSL_KEY_FILE" ] || die "SSL_KEY_FILE was not found: $SSL_KEY_FILE"
    return
  fi

  local certificate_dir
  for certificate_dir in \
    "/www/server/panel/vhost/cert/${APP_DOMAIN}" \
    "/www/server/panel/vhost/cert/${APP_APEX_DOMAIN}" \
    "/etc/letsencrypt/live/${APP_DOMAIN}" \
    "/etc/letsencrypt/live/${APP_APEX_DOMAIN}"; do
    if [ -f "${certificate_dir}/fullchain.pem" ] && [ -f "${certificate_dir}/privkey.pem" ]; then
      SSL_CERT_FILE="${certificate_dir}/fullchain.pem"
      SSL_KEY_FILE="${certificate_dir}/privkey.pem"
      return
    fi
  done

  die "No SSL certificate was found. Issue one for ${APP_APEX_DOMAIN} and ${APP_DOMAIN} in aaPanel/Certbot, then rerun this command."
}

main() {
  [ "$(id -u)" -eq 0 ] || die 'Run as root.'
  [ -d "$APP_DIR" ] || die "APP_DIR does not exist: $APP_DIR"
  [ -f "$APP_DIR/.env" ] || die "Missing ${APP_DIR}/.env"
  [ -f "$TEMPLATE_FILE" ] || die "Missing Nginx template: $TEMPLATE_FILE"
  [[ "$APP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ && "$APP_DOMAIN" == *.* ]] || die "APP_DOMAIN is not a valid hostname: $APP_DOMAIN"
  [[ "$APP_APEX_DOMAIN" =~ ^[A-Za-z0-9.-]+$ && "$APP_APEX_DOMAIN" == *.* ]] || die "APP_APEX_DOMAIN is not a valid hostname: $APP_APEX_DOMAIN"
  [[ "$APP_PORT" =~ ^[0-9]{2,5}$ ]] || die "APP_PORT is invalid: $APP_PORT"

  choose_nginx
  choose_config_path
  choose_certificate
  info "Using Nginx virtual host: ${NGINX_CONF}"

  local backup_path=""
  TEMPORARY_CONFIG="$(mktemp /tmp/kaki-crm-nginx.XXXXXX)"
  trap 'rm -f -- "$TEMPORARY_CONFIG"' EXIT
  sed \
    -e "s|__DOMAIN__|${APP_DOMAIN}|g" \
    -e "s|__APEX_DOMAIN__|${APP_APEX_DOMAIN}|g" \
    -e "s|__APP_PORT__|${APP_PORT}|g" \
    -e "s|__SSL_CERT_FILE__|${SSL_CERT_FILE}|g" \
    -e "s|__SSL_KEY_FILE__|${SSL_KEY_FILE}|g" \
    "$TEMPLATE_FILE" > "$TEMPORARY_CONFIG"

  install -d -m 0755 "$(dirname "$NGINX_CONF")"
  if [ -f "$NGINX_CONF" ]; then
    backup_path="${NGINX_CONF}.before-kaki-domain-$(date +%Y%m%d-%H%M%S)"
    cp -p "$NGINX_CONF" "$backup_path"
    info "Backed up the current virtual-host file to ${backup_path}"
  fi
  install -m 0644 "$TEMPORARY_CONFIG" "$NGINX_CONF"

  if [ -d /etc/nginx/sites-enabled ] && [[ "$NGINX_CONF" == /etc/nginx/sites-available/* ]]; then
    ln -sfn "$NGINX_CONF" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
  fi

  if ! "$NGINX_BIN" -t; then
    if [ -n "$backup_path" ]; then
      cp -p "$backup_path" "$NGINX_CONF"
    else
      rm -f -- "$NGINX_CONF"
    fi
    die 'Nginx configuration validation failed; the previous virtual host was restored.'
  fi

  info "Setting the public CRM origin to ${APP_ORIGIN}"
  set_env_value NODE_ENV production
  set_env_value PORT "$APP_PORT"
  set_env_value HOST 127.0.0.1
  set_env_value CORS_ORIGIN "$APP_ORIGIN"

  info 'Reloading PM2 with the HTTPS browser origin'
  pm2 describe "$APP_NAME" >/dev/null 2>&1 || die "PM2 process '${APP_NAME}' was not found. Run the application installer first."
  pm2 reload "$APP_NAME" --update-env
  pm2 save --force

  if [ "$NGINX_BIN" = /www/server/nginx/sbin/nginx ]; then
    "$NGINX_BIN" -s reload
  elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    "$NGINX_BIN" -s reload
  fi

  curl --fail --silent --show-error --resolve "${APP_DOMAIN}:443:127.0.0.1" "https://${APP_DOMAIN}/api/health" >/dev/null
  info "Domain deployment is ready at https://${APP_DOMAIN}/"
}

main "$@"

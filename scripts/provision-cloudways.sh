#!/usr/bin/env bash
# One-shot Cloudways provisioning for WaGuard: installs Node + build tools,
# clones/builds the app, runs it under PM2, wires up the Nginx reverse proxy,
# and issues a Let's Encrypt certificate — everything this repo's
# docs/DEPLOY_CLOUDWAYS.md guide otherwise has you do by hand, step by step.
#
# Run ONCE, on the server, over SSH as the Cloudways master/sudo user:
#   ./scripts/provision-cloudways.sh
# (or pipe it straight from the repo before you even have a local clone —
#  see the one-liner in docs/DEPLOY_CLOUDWAYS.md).
#
# Re-running it is safe (every step is idempotent) but it's meant to be run once.
#
# ------------------------------------------------------------------------
# What this script CANNOT do for you — Cloudways gives no API/SSH surface
# for these, so they must already be done before you run it:
#   1. The Cloudways server + a placeholder PHP application already created
#      in the Cloudways console (this script just uses the VPS underneath it).
#   2. A DNS A record for DOMAIN pointing at this server's public IP.
#   3. That domain attached to the placeholder app in the Cloudways console
#      (Application → Domain Management) — this is what makes Cloudways
#      generate the per-app Nginx vhost file this script edits.
# The script checks (1)-(3) as best it can and fails fast with a clear
# message instead of half-provisioning something if they're missing.
# ------------------------------------------------------------------------
#
# Configure via environment variables (all but DOMAIN have defaults):
#   DOMAIN            (required) e.g. wa.example.com — must already resolve here
#   GIT_REPO          default: https://github.com/aicodeblocks/whatsApp-unofficial-api.git
#   GIT_BRANCH        default: main
#   APP_DIR           default: $HOME/waguard
#   NODE_PORT         default: 3000
#   LETSENCRYPT_EMAIL default: admin@<DOMAIN>  (used for certbot renewal notices)
#   NGINX_VHOST_PATH  default: auto-detected under
#                      /home/master/applications/*/conf/server.nginx
#                      (Cloudways' per-app Nginx include) — set explicitly if
#                      auto-detection picks the wrong app on a multi-app server.
#   SKIP_SSL          default: 0 — set to 1 to skip the certbot step
#
# Example:
#   DOMAIN=wa.example.com LETSENCRYPT_EMAIL=me@example.com \
#     ./scripts/provision-cloudways.sh

set -euo pipefail

# ---- config -------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
GIT_REPO="${GIT_REPO:-https://github.com/aicodeblocks/whatsApp-unofficial-api.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/waguard}"
NODE_PORT="${NODE_PORT:-3000}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-admin@${DOMAIN}}"
NGINX_VHOST_PATH="${NGINX_VHOST_PATH:-}"
SKIP_SSL="${SKIP_SSL:-0}"
PM2_APP_NAME="waguard"

LOG_DIR="$HOME/waguard-provision-logs"
LOG_FILE="$LOG_DIR/provision-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$LOG_DIR"

# ---- logging & error handling -------------------------------------------
# Everything from here on is duplicated to both the terminal and LOG_FILE.
exec > >(tee -a "$LOG_FILE") 2>&1

CURRENT_STEP="startup"
step() { CURRENT_STEP="$1"; echo; echo "==> [$(date '+%H:%M:%S')] $1"; }
on_error() {
  echo
  echo "!! FAILED during: $CURRENT_STEP"
  echo "!! See full log: $LOG_FILE"
  exit 1
}
trap on_error ERR

echo "WaGuard Cloudways provisioning — log: $LOG_FILE"
echo "Started: $(date)"

# ---- validate inputs ------------------------------------------------------
step "Validating configuration"
if [ -z "$DOMAIN" ]; then
  echo "DOMAIN is required, e.g.:"
  echo "  DOMAIN=wa.example.com ./scripts/provision-cloudways.sh"
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null; then
    echo "This script needs passwordless-or-prompted sudo for package installs"
    echo "and Nginx reload. Run as the Cloudways master user (has sudo) or root."
    exit 1
  fi
fi

step "Checking DNS for $DOMAIN"
SERVER_IP="$(curl -fsS https://ifconfig.me || curl -fsS https://api.ipify.org)"
RESOLVED_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
if [ -z "$RESOLVED_IP" ]; then
  echo "Could not resolve $DOMAIN at all. Point its DNS A record at this"
  echo "server's IP ($SERVER_IP) before running this script, then retry."
  exit 1
fi
if [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
  echo "$DOMAIN resolves to $RESOLVED_IP, but this server's IP is $SERVER_IP."
  echo "Fix the DNS A record (or wait for propagation) before continuing."
  exit 1
fi
echo "OK — $DOMAIN -> $SERVER_IP"

step "Locating the Cloudways Nginx vhost for this domain"
if [ -z "$NGINX_VHOST_PATH" ]; then
  NGINX_VHOST_PATH="$(grep -rls "$DOMAIN" /home/master/applications/*/conf/server.nginx 2>/dev/null | head -n1 || true)"
fi
if [ -z "$NGINX_VHOST_PATH" ] || [ ! -f "$NGINX_VHOST_PATH" ]; then
  echo "Couldn't find a Cloudways Nginx vhost mentioning $DOMAIN under"
  echo "/home/master/applications/*/conf/server.nginx."
  echo "Attach $DOMAIN to a placeholder app in the Cloudways console first"
  echo "(Application -> Domain Management), or pass NGINX_VHOST_PATH=... explicitly."
  exit 1
fi
echo "Using vhost: $NGINX_VHOST_PATH"

# ---- Node.js + build tools ------------------------------------------------
step "Installing Node.js 20 and native build tools"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  echo "Node $(node -v) already installed, skipping"
fi
$SUDO apt-get install -y build-essential python3 git
node -v
npm -v

step "Installing PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  $SUDO npm install -g pm2
else
  echo "PM2 already installed, skipping"
fi

# ---- fetch + build the app -------------------------------------------------
step "Fetching WaGuard ($GIT_REPO#$GIT_BRANCH) into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$GIT_BRANCH"
  git -C "$APP_DIR" checkout "$GIT_BRANCH"
  git -C "$APP_DIR" merge --ff-only "origin/$GIT_BRANCH"
else
  git clone --branch "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"
fi

step "Installing dependencies and building"
cd "$APP_DIR"
npm install
npm run build
npm prune --omit=dev

step "Writing .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi
SESSION_SECRET_VALUE="$(openssl rand -hex 32)"
set_env() { # set_env KEY VALUE — replaces an existing (possibly commented) line, or appends
  local key="$1" value="$2"
  if grep -qE "^#?${key}=" "$APP_DIR/.env"; then
    sed -i "s|^#\?${key}=.*|${key}=${value}|" "$APP_DIR/.env"
  else
    echo "${key}=${value}" >>"$APP_DIR/.env"
  fi
}
set_env PORT "$NODE_PORT"
set_env COOKIE_SECURE "true"
set_env PUBLIC_BASE_URL "https://${DOMAIN}"
if ! grep -qE "^SESSION_SECRET=.+" "$APP_DIR/.env"; then
  set_env SESSION_SECRET "$SESSION_SECRET_VALUE"
fi

# ---- run under PM2 ----------------------------------------------------------
step "Starting WaGuard under PM2"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env
else
  pm2 start "$APP_DIR/dist/server.js" --name "$PM2_APP_NAME"
fi
pm2 save

step "Enabling PM2 on server boot"
STARTUP_CMD="$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" | grep -E '^sudo ' || true)"
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD"
else
  echo "pm2 startup didn't print a command to run — it may already be configured; continuing"
fi
pm2 save

# ---- Nginx reverse proxy ------------------------------------------------------
step "Wiring the Nginx reverse proxy"
MARKER="# waguard-provision: proxy to node ${NODE_PORT}"
if ! grep -qF "$MARKER" "$NGINX_VHOST_PATH"; then
  $SUDO cp "$NGINX_VHOST_PATH" "${NGINX_VHOST_PATH}.bak-$(date +%s)"
  $SUDO tee -a "$NGINX_VHOST_PATH" >/dev/null <<EOF

$MARKER
location / {
    proxy_pass http://127.0.0.1:${NODE_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
EOF
else
  echo "Proxy block already present, skipping"
fi
$SUDO nginx -t
$SUDO service nginx reload

# ---- SSL --------------------------------------------------------------------
if [ "$SKIP_SSL" != "1" ]; then
  step "Issuing a Let's Encrypt certificate for $DOMAIN"
  if ! command -v certbot >/dev/null 2>&1; then
    $SUDO apt-get install -y certbot python3-certbot-nginx
  fi
  $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    -m "$LETSENCRYPT_EMAIL" --redirect || {
    echo "certbot failed — Nginx + PM2 are still up on plain HTTP;"
    echo "see $LOG_FILE and retry SSL manually (or Cloudways' own SSL tab)."
  }
else
  step "Skipping SSL (SKIP_SSL=1)"
fi

# ---- verify -------------------------------------------------------------------
step "Verifying"
sleep 2
if [ "$SKIP_SSL" != "1" ]; then
  CHECK_URL="https://${DOMAIN}"
else
  CHECK_URL="http://${DOMAIN}"
fi
if curl -fsSI "$CHECK_URL" >/dev/null; then
  echo "OK — $CHECK_URL is responding."
else
  echo "WARNING — $CHECK_URL did not respond as expected; check pm2 logs $PM2_APP_NAME"
  echo "and $LOG_FILE."
fi

echo
echo "================================================================"
echo " Done. WaGuard should now be live at: $CHECK_URL"
echo " Full log: $LOG_FILE"
echo " To deploy future code changes, run: $APP_DIR/scripts/deploy.sh"
echo "================================================================"

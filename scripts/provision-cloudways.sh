#!/usr/bin/env bash
# One-shot Cloudways provisioning for WaGuard, menu-driven with a dry-run mode.
#
# Cloudways deploys the code itself (its UI's Git deployment feature, over an
# SSH key you manage there) — this script does NOT clone or pull anything.
# Run it FROM INSIDE the already-deployed app directory (the folder that has
# package.json, .env.example, etc. — typically
# /home/master/applications/<app>/public_html), over SSH, as the Cloudways
# master/sudo user:
#
#   cd /home/master/applications/<app>/public_html
#   ./scripts/provision-cloudways.sh
#
# It opens a menu:
#   1) Dry run  — checks everything and logs what WOULD happen; makes no
#                 changes to the system. Tells you up front whether Apply
#                 is likely to succeed or where it will fail.
#   2) Apply    — does the real, one-time setup: Node + build tools + PM2,
#                 npm install/build, .env with production settings, PM2
#                 start + boot persistence, Nginx reverse proxy, Let's
#                 Encrypt SSL. Safe to re-run (idempotent).
#   3) Exit
#
# Both modes write a full, timestamped log to ~/waguard-provision-logs/.
# Non-interactive use (CI, `curl | bash`, etc.): pass the mode instead of
# using the menu, e.g. `./provision-cloudways.sh --dry-run` or `--apply`.
#
# ------------------------------------------------------------------------
# What this script still can't do for you (no SSH-reachable API for these):
#   1. The Cloudways server + app already created in the Cloudways console,
#      and the code already deployed into this directory via its Git
#      deployment feature.
#   2. A DNS A record for DOMAIN pointing at this server's public IP.
#   3. That domain attached to this app in the Cloudways console
#      (Application -> Domain Management) — this is what makes Cloudways
#      generate the per-app Nginx vhost file this script edits.
# Both dry-run and apply check for these and fail with a clear message
# instead of guessing.
# ------------------------------------------------------------------------
#
# Configure via environment variables (all but DOMAIN have defaults):
#   DOMAIN            (required) e.g. wa.example.com — must already resolve here
#   NODE_PORT         default: 3000
#   LETSENCRYPT_EMAIL default: admin@<DOMAIN>  (used for certbot renewal notices)
#   NGINX_VHOST_PATH  default: auto-detected under
#                      /home/master/applications/*/conf/server.nginx
#                      (Cloudways' per-app Nginx include) — set explicitly if
#                      auto-detection picks the wrong app on a multi-app server.
#   SKIP_SSL          default: 0 — set to 1 to skip the certbot step entirely
#
# Example:
#   DOMAIN=wa.example.com LETSENCRYPT_EMAIL=me@example.com \
#     ./scripts/provision-cloudways.sh --apply

set -uo pipefail

# ---- config ---------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
NODE_PORT="${NODE_PORT:-3000}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-admin@${DOMAIN}}"
NGINX_VHOST_PATH="${NGINX_VHOST_PATH:-}"
SKIP_SSL="${SKIP_SSL:-0}"
PM2_APP_NAME="waguard"
APP_DIR="$(pwd)"

MODE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

LOG_DIR="$HOME/waguard-provision-logs"
LOG_FILE="$LOG_DIR/provision-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$LOG_DIR"

# Everything printed from here on goes to both the terminal and LOG_FILE.
exec > >(tee -a "$LOG_FILE") 2>&1

# ---- menu -------------------------------------------------------------
if [ -z "$MODE" ]; then
  if [ -t 0 ]; then
    echo "WaGuard Cloudways Provisioning"
    echo "  1) Dry run  — check everything, make no changes"
    echo "  2) Apply    — perform the real setup"
    echo "  3) Exit"
    read -rp "Choose [1-3]: " choice
    case "$choice" in
      1) MODE="dry-run" ;;
      2) MODE="apply" ;;
      *) echo "Exiting, nothing done."; exit 0 ;;
    esac
  else
    echo "Not running in a terminal — pass --dry-run or --apply explicitly."
    exit 1
  fi
fi

echo "WaGuard Cloudways provisioning — mode: $MODE"
echo "Log: $LOG_FILE"
echo "App directory: $APP_DIR"
echo "Started: $(date)"

# ---- bookkeeping ------------------------------------------------------
ISSUES=0
CURRENT_STEP="startup"
step() { CURRENT_STEP="$1"; echo; echo "==> [$(date '+%H:%M:%S')] $1"; }
issue() { echo "   ISSUE: $1"; ISSUES=$((ISSUES + 1)); }
ok() { echo "   OK: $1"; }
info() { echo "   $1"; }

# fail_now: unrecoverable in EITHER mode (can't even evaluate further checks
# meaningfully without it) — e.g. DOMAIN unset, app dir isn't the app.
fail_now() {
  echo
  echo "!! STOPPING during: $CURRENT_STEP"
  echo "!! $1"
  echo "!! Log: $LOG_FILE"
  exit 1
}

# run_step NAME APPLY_CMD... — dry-run just announces it; apply runs it and
# stops the whole script on failure (fail-fast, matching the log to exactly
# how far setup got).
run_step() {
  local name="$1"; shift
  if [ "$MODE" = "dry-run" ]; then
    info "[DRY-RUN] would run: $*"
    return 0
  fi
  info "running: $*"
  if "$@"; then
    ok "$name"
  else
    echo
    echo "!! FAILED during: $CURRENT_STEP ($name)"
    echo "!! Command: $*"
    echo "!! Log: $LOG_FILE"
    exit 1
  fi
}

SUDO="sudo"
[ "$(id -u)" -eq 0 ] && SUDO=""

# ---- validate inputs --------------------------------------------------
step "Validating configuration"
[ -z "$DOMAIN" ] && fail_now "DOMAIN is required, e.g.: DOMAIN=wa.example.com ./scripts/provision-cloudways.sh"
ok "DOMAIN=$DOMAIN"

if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  fail_now "Need passwordless-or-cached sudo. Run as the Cloudways master user (has sudo) or root."
fi
ok "sudo access confirmed"

step "Checking this is a deployed WaGuard app directory"
if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/.env.example" ]; then
  fail_now "No package.json/.env.example in $APP_DIR. cd into the app directory Cloudways deployed the code into (its Git deployment feature), then re-run."
fi
ok "found package.json + .env.example in $APP_DIR"

step "Checking DNS for $DOMAIN"
SERVER_IP="$(curl -fsS https://ifconfig.me || curl -fsS https://api.ipify.org || true)"
RESOLVED_IP="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
if [ -z "$SERVER_IP" ]; then
  issue "Couldn't determine this server's public IP (outbound network issue?)."
elif [ -z "$RESOLVED_IP" ]; then
  issue "$DOMAIN does not resolve at all. Point its DNS A record at $SERVER_IP."
elif [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
  issue "$DOMAIN resolves to $RESOLVED_IP, but this server's IP is $SERVER_IP. Fix the DNS A record."
else
  ok "$DOMAIN -> $SERVER_IP"
fi

step "Locating the Cloudways Nginx vhost for this domain"
if [ -z "$NGINX_VHOST_PATH" ]; then
  NGINX_VHOST_PATH="$(grep -rls "$DOMAIN" /home/master/applications/*/conf/server.nginx 2>/dev/null | head -n1 || true)"
fi
if [ -z "$NGINX_VHOST_PATH" ] || [ ! -f "$NGINX_VHOST_PATH" ]; then
  issue "No Cloudways Nginx vhost mentioning $DOMAIN found under /home/master/applications/*/conf/server.nginx. Attach $DOMAIN to this app in the Cloudways console (Application -> Domain Management), or pass NGINX_VHOST_PATH=... explicitly."
else
  ok "vhost: $NGINX_VHOST_PATH"
fi

# ---- Node.js + build tools ----------------------------------------------
step "Node.js 20 and native build tools"
NODE_OK=0
if command -v node >/dev/null 2>&1 && [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -ge 20 ]; then
  ok "Node $(node -v) already installed"
  NODE_OK=1
fi
if [ "$MODE" = "dry-run" ]; then
  if [ "$NODE_OK" -eq 0 ]; then
    info "[DRY-RUN] would install Node 20.x via NodeSource"
    if ! curl -fsSL https://deb.nodesource.com/setup_20.x -o /dev/null; then
      issue "Can't reach deb.nodesource.com to fetch the Node setup script — check outbound network/DNS."
    fi
  fi
  if $SUDO apt-get install --dry-run -y build-essential python3 git >/tmp/apt-sim.$$ 2>&1; then
    ok "build-essential/python3/git installable (apt --dry-run)"
  else
    issue "apt-get can't resolve build-essential/python3/git — see /tmp/apt-sim.$$"
  fi
  rm -f "/tmp/apt-sim.$$"
else
  if [ "$NODE_OK" -eq 0 ]; then
    run_step "install Node 20.x" bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs"
  fi
  run_step "install build tools" $SUDO apt-get install -y build-essential python3 git
  node -v; npm -v
fi

step "PM2"
if command -v pm2 >/dev/null 2>&1; then
  ok "PM2 already installed ($(pm2 -v))"
else
  if [ "$MODE" = "dry-run" ]; then
    info "[DRY-RUN] would run: $SUDO npm install -g pm2"
  else
    run_step "install PM2" $SUDO npm install -g pm2
  fi
fi

# ---- dependencies + build -----------------------------------------------
cd "$APP_DIR"

step "Dependencies (npm install)"
if [ "$MODE" = "dry-run" ]; then
  if npm install --dry-run >/tmp/npm-dry.$$ 2>&1; then
    ok "npm install --dry-run succeeded (see log for the plan)"
    cat /tmp/npm-dry.$$
  else
    issue "npm install --dry-run failed — package.json/package-lock.json problem. See below:"
    cat /tmp/npm-dry.$$
  fi
  rm -f "/tmp/npm-dry.$$"
else
  run_step "npm install" npm install
fi

step "Build (TypeScript compile)"
if [ "$MODE" = "dry-run" ]; then
  if npx tsc --noEmit -p tsconfig.json 2>/tmp/tsc-dry.$$; then
    ok "TypeScript compiles cleanly (tsc --noEmit)"
  else
    issue "TypeScript fails to compile — npm run build would fail. See below:"
    cat /tmp/tsc-dry.$$
  fi
  rm -f "/tmp/tsc-dry.$$"
else
  run_step "npm run build" npm run build
  run_step "npm prune --omit=dev" npm prune --omit=dev
fi

# ---- .env -----------------------------------------------------------------
step ".env (PORT, COOKIE_SECURE, PUBLIC_BASE_URL, SESSION_SECRET)"
set_env() { # set_env KEY VALUE — replaces an existing (possibly commented) line, or appends
  local key="$1" value="$2" file="$3"
  if grep -qE "^#?${key}=" "$file"; then
    sed -i "s|^#\?${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >>"$file"
  fi
}
if [ "$MODE" = "dry-run" ]; then
  TMP_ENV="/tmp/waguard-env-preview.$$"
  if [ -f "$APP_DIR/.env" ]; then cp "$APP_DIR/.env" "$TMP_ENV"; else cp "$APP_DIR/.env.example" "$TMP_ENV"; fi
  cp "$TMP_ENV" "${TMP_ENV}.orig"
  set_env PORT "$NODE_PORT" "$TMP_ENV"
  set_env COOKIE_SECURE "true" "$TMP_ENV"
  set_env PUBLIC_BASE_URL "https://${DOMAIN}" "$TMP_ENV"
  grep -qE "^SESSION_SECRET=.+" "$TMP_ENV" || set_env SESSION_SECRET "<generated-on-apply>" "$TMP_ENV"
  info "[DRY-RUN] .env diff that would be applied:"
  diff -u "${TMP_ENV}.orig" "$TMP_ENV" || true
  rm -f "$TMP_ENV" "${TMP_ENV}.orig"
else
  [ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  set_env PORT "$NODE_PORT" "$APP_DIR/.env"
  set_env COOKIE_SECURE "true" "$APP_DIR/.env"
  set_env PUBLIC_BASE_URL "https://${DOMAIN}" "$APP_DIR/.env"
  grep -qE "^SESSION_SECRET=.+" "$APP_DIR/.env" || set_env SESSION_SECRET "$(openssl rand -hex 32)" "$APP_DIR/.env"
  ok ".env written"
fi

# ---- PM2 --------------------------------------------------------------------
step "PM2 process (start/restart + boot persistence)"
if [ "$MODE" = "dry-run" ]; then
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    info "[DRY-RUN] would run: pm2 restart $PM2_APP_NAME --update-env"
  else
    info "[DRY-RUN] would run: pm2 start $APP_DIR/dist/server.js --name $PM2_APP_NAME"
  fi
  info "[DRY-RUN] would run: pm2 save && pm2 startup systemd (+ the sudo command it prints) && pm2 save"
else
  if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    run_step "pm2 restart" pm2 restart "$PM2_APP_NAME" --update-env
  else
    run_step "pm2 start" pm2 start "$APP_DIR/dist/server.js" --name "$PM2_APP_NAME"
  fi
  run_step "pm2 save" pm2 save
  STARTUP_CMD="$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" | grep -E '^sudo ' || true)"
  if [ -n "$STARTUP_CMD" ]; then
    run_step "pm2 startup" bash -c "$STARTUP_CMD"
  else
    info "pm2 startup already configured or nothing to do"
  fi
  run_step "pm2 save (after startup)" pm2 save
fi

# ---- Nginx reverse proxy --------------------------------------------------
step "Nginx reverse proxy"
MARKER="# waguard-provision: proxy to node ${NODE_PORT}"
if [ -z "$NGINX_VHOST_PATH" ] || [ ! -f "$NGINX_VHOST_PATH" ]; then
  info "skipped — no vhost path (see earlier issue)"
elif grep -qF "$MARKER" "$NGINX_VHOST_PATH" 2>/dev/null; then
  ok "proxy block already present in $NGINX_VHOST_PATH"
else
  PROXY_BLOCK="
$MARKER
location / {
    proxy_pass http://127.0.0.1:${NODE_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}"
  if [ "$MODE" = "dry-run" ]; then
    info "[DRY-RUN] would append this block to $NGINX_VHOST_PATH and reload Nginx:"
    echo "$PROXY_BLOCK"
    TMP_NGINX="/tmp/waguard-nginx-check.$$"
    cp "$NGINX_VHOST_PATH" "$TMP_NGINX"
    echo "$PROXY_BLOCK" >>"$TMP_NGINX"
    if $SUDO nginx -t -c "$TMP_NGINX" >/tmp/nginx-t.$$ 2>&1; then
      ok "resulting config passes 'nginx -t' (isolated check)"
    else
      info "note: isolated 'nginx -t -c' check against the real main config isn't reliable for an include snippet; skipping strict validation here — real 'nginx -t' runs before reload in apply mode."
    fi
    rm -f "$TMP_NGINX" "/tmp/nginx-t.$$"
  else
    $SUDO cp "$NGINX_VHOST_PATH" "${NGINX_VHOST_PATH}.bak-$(date +%s)"
    echo "$PROXY_BLOCK" | $SUDO tee -a "$NGINX_VHOST_PATH" >/dev/null
    run_step "nginx -t" $SUDO nginx -t
    run_step "reload nginx" $SUDO service nginx reload
  fi
fi

# ---- SSL --------------------------------------------------------------------
if [ "$SKIP_SSL" = "1" ]; then
  step "SSL — skipped (SKIP_SSL=1)"
else
  step "Let's Encrypt certificate for $DOMAIN"
  if ! command -v certbot >/dev/null 2>&1; then
    if [ "$MODE" = "dry-run" ]; then
      info "[DRY-RUN] would run: $SUDO apt-get install -y certbot python3-certbot-nginx"
    else
      run_step "install certbot" $SUDO apt-get install -y certbot python3-certbot-nginx
    fi
  else
    ok "certbot already installed"
  fi
  if [ "$MODE" = "dry-run" ]; then
    if command -v certbot >/dev/null 2>&1; then
      if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect --dry-run >/tmp/certbot-dry.$$ 2>&1; then
        ok "certbot --dry-run succeeded — issuance should work"
      else
        issue "certbot --dry-run failed. See below:"
        cat /tmp/certbot-dry.$$
      fi
      rm -f "/tmp/certbot-dry.$$"
    else
      info "certbot not installed yet — can't dry-run issuance; will be checked once installed on apply."
    fi
  else
    if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect; then
      ok "certificate issued"
    else
      issue "certbot failed — Nginx + PM2 are still up on plain HTTP. Retry manually or via Cloudways' own SSL tab."
    fi
  fi
fi

# ---- verify (apply mode only — dry-run changed nothing to verify) ---------
if [ "$MODE" = "apply" ]; then
  step "Verifying"
  sleep 2
  CHECK_URL="http://${DOMAIN}"
  [ "$SKIP_SSL" != "1" ] && CHECK_URL="https://${DOMAIN}"
  if curl -fsSI "$CHECK_URL" >/dev/null 2>&1; then
    ok "$CHECK_URL is responding"
  else
    issue "$CHECK_URL did not respond as expected — check: pm2 logs $PM2_APP_NAME"
  fi
fi

# ---- summary ----------------------------------------------------------------
echo
echo "================================================================"
if [ "$MODE" = "dry-run" ]; then
  if [ "$ISSUES" -eq 0 ]; then
    echo " DRY RUN COMPLETE — no issues found. Apply should succeed:"
    echo "   ./scripts/provision-cloudways.sh --apply"
  else
    echo " DRY RUN COMPLETE — $ISSUES issue(s) found above. Fix them before"
    echo " running --apply, or apply will likely fail at the same point."
  fi
else
  if [ "$ISSUES" -eq 0 ]; then
    echo " APPLY COMPLETE — WaGuard should now be live."
  else
    echo " APPLY COMPLETE WITH $ISSUES WARNING(S) — see above."
  fi
  echo " To deploy future code changes: Cloudways Git-deploy the update,"
  echo " then from this directory run: ./scripts/deploy.sh"
fi
echo " Full log: $LOG_FILE"
echo "================================================================"
[ "$ISSUES" -gt 0 ] && exit 1
exit 0

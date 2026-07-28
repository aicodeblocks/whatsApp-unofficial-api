#!/usr/bin/env bash
# One-shot Cloudways provisioning for WaGuard — IP-only mode, no domain
# required: no Nginx reverse proxy, no Let's Encrypt. WaGuard is served
# directly by Node on its own port (plain HTTP).
#
# Use this instead of provision-cloudways.sh when you don't have (or don't
# want to wait on) a domain pointed at this server yet — quick testing, an
# internal tool, or access restricted to trusted IPs via the Cloudways
# firewall. See docs/DEPLOY_CLOUDWAYS_IP.md for the trade-offs.
#
# Cloudways deploys the code itself (its UI's Git deployment feature, over an
# SSH key you manage there) — this script does NOT clone or pull anything.
# Run it FROM INSIDE the already-deployed app directory (the folder that has
# package.json, .env.example, etc. — typically
# /home/master/applications/<app>/public_html), over SSH, as the Cloudways
# master/sudo user:
#
#   cd /home/master/applications/<app>/public_html
#   ./scripts/provision-cloudways-ip.sh
#
# It opens a menu:
#   1) Dry run  — checks everything and logs what WOULD happen; makes no
#                 changes to the system. Tells you up front whether Apply
#                 is likely to succeed or where it will fail.
#   2) Apply    — does the real, one-time setup: Node + build tools + PM2,
#                 npm install/build, .env with plain-HTTP settings, PM2
#                 start + boot persistence. Safe to re-run (idempotent).
#   3) Exit
#
# Both modes write a full, timestamped log to ~/waguard-provision-logs/.
# Non-interactive use (CI, `curl | bash`, etc.): pass the mode instead of
# using the menu, e.g. `./provision-cloudways-ip.sh --dry-run` or `--apply`.
#
# ------------------------------------------------------------------------
# What this script still can't do for you (no SSH-reachable API for these):
#   1. The Cloudways server + app already created in the Cloudways console,
#      and the code already deployed into this directory via its Git
#      deployment feature.
#   2. Opening NODE_PORT to the internet (or to specific IPs) in Cloudways'
#      firewall (server -> Manage Services / Firewall Management). Without
#      this, the app is only reachable from inside the server.
# Both dry-run and apply check what they can and fail with a clear message
# instead of guessing.
# ------------------------------------------------------------------------
#
# Configure via environment variables (all have defaults):
#   NODE_PORT   default: 3000
#   PUBLIC_IP   default: auto-detected via ifconfig.me/ipify — set explicitly
#               if this server has a different public-facing IP (e.g. NAT).
#
# Example:
#   NODE_PORT=3000 ./scripts/provision-cloudways-ip.sh --apply
#
# No HTTPS in this mode: traffic (including admin login and API tokens) is
# unencrypted. Fine for localhost-only or trusted-network access; not fine
# for anything public. Outgrow this later by switching to
# provision-cloudways.sh once you have a domain.

set -uo pipefail

# ---- config ---------------------------------------------------------------
NODE_PORT="${NODE_PORT:-3000}"
PUBLIC_IP="${PUBLIC_IP:-}"
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
LOG_FILE="$LOG_DIR/provision-ip-$(date +%Y%m%d-%H%M%S).log"
mkdir -p "$LOG_DIR"

# Everything printed from here on goes to both the terminal and LOG_FILE.
exec > >(tee -a "$LOG_FILE") 2>&1

# ---- menu -------------------------------------------------------------
if [ -z "$MODE" ]; then
  if [ -t 0 ]; then
    echo "WaGuard Cloudways Provisioning — IP-only mode (no domain, no SSL)"
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

echo "WaGuard Cloudways provisioning (IP-only) — mode: $MODE"
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
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  fail_now "Need passwordless-or-cached sudo. Run as the Cloudways master user (has sudo) or root."
fi
ok "sudo access confirmed"

step "Checking this is a deployed WaGuard app directory"
if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/.env.example" ]; then
  fail_now "No package.json/.env.example in $APP_DIR. cd into the app directory Cloudways deployed the code into (its Git deployment feature), then re-run."
fi
ok "found package.json + .env.example in $APP_DIR"

step "Determining this server's public IP"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS https://ifconfig.me || curl -fsS https://api.ipify.org || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  issue "Couldn't determine this server's public IP (outbound network issue?). Set PUBLIC_IP=... explicitly."
else
  ok "PUBLIC_IP=$PUBLIC_IP"
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
BASE_URL_HOST="${PUBLIC_IP:-<server-ip>}"
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
  set_env COOKIE_SECURE "false" "$TMP_ENV"
  set_env PUBLIC_BASE_URL "http://${BASE_URL_HOST}:${NODE_PORT}" "$TMP_ENV"
  grep -qE "^SESSION_SECRET=.+" "$TMP_ENV" || set_env SESSION_SECRET "<generated-on-apply>" "$TMP_ENV"
  info "[DRY-RUN] .env diff that would be applied:"
  diff -u "${TMP_ENV}.orig" "$TMP_ENV" || true
  rm -f "$TMP_ENV" "${TMP_ENV}.orig"
else
  [ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  set_env PORT "$NODE_PORT" "$APP_DIR/.env"
  set_env COOKIE_SECURE "false" "$APP_DIR/.env"
  set_env PUBLIC_BASE_URL "http://${BASE_URL_HOST}:${NODE_PORT}" "$APP_DIR/.env"
  grep -qE "^SESSION_SECRET=.+" "$APP_DIR/.env" || set_env SESSION_SECRET "$(openssl rand -hex 32)" "$APP_DIR/.env"
  ok ".env written (plain HTTP, COOKIE_SECURE=false)"
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

# ---- firewall reminder (no SSH-reachable API to do this for the user) ------
step "Firewall — NODE_PORT ${NODE_PORT} reachability"
info "This script cannot open ports in Cloudways' firewall (no SSH-reachable"
info "API for it). In the Cloudways console: server -> Manage Services /"
info "Firewall Management -> open port ${NODE_PORT} (to the internet, or"
info "restrict to specific trusted IPs — recommended, since this mode has no TLS)."

# ---- verify (apply mode only — dry-run changed nothing to verify) ---------
if [ "$MODE" = "apply" ]; then
  step "Verifying (local check — firewall may still block external access)"
  sleep 2
  if curl -fsSI "http://127.0.0.1:${NODE_PORT}" >/dev/null 2>&1; then
    ok "http://127.0.0.1:${NODE_PORT} is responding locally"
  else
    issue "http://127.0.0.1:${NODE_PORT} did not respond as expected — check: pm2 logs $PM2_APP_NAME"
  fi
fi

# ---- summary ----------------------------------------------------------------
echo
echo "================================================================"
if [ "$MODE" = "dry-run" ]; then
  if [ "$ISSUES" -eq 0 ]; then
    echo " DRY RUN COMPLETE — no issues found. Apply should succeed:"
    echo "   ./scripts/provision-cloudways-ip.sh --apply"
  else
    echo " DRY RUN COMPLETE — $ISSUES issue(s) found above. Fix them before"
    echo " running --apply, or apply will likely fail at the same point."
  fi
else
  if [ "$ISSUES" -eq 0 ]; then
    echo " APPLY COMPLETE — WaGuard should now be reachable at:"
    echo "   http://${BASE_URL_HOST}:${NODE_PORT}"
    echo " (once the firewall port is opened — see the step above)."
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

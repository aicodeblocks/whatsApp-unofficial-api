#!/usr/bin/env bash
# One-shot Cloudways provisioning for WaGuard, following Cloudways' own
# guidance for hosting a Node.js app on a PHP Application server:
# https://www.cloudways.com/blog/how-to-host-a-node-js-application/
#
# WaGuard runs as a Node process under PM2, reverse-proxied by Apache via
# .htaccess (mod_proxy) — the repo's root .htaccess handles that part
# automatically since Cloudways deploys it along with the rest of the code.
# This script does everything Cloudways' Git deploy doesn't do for a Node
# app: install Node/build tools/PM2, build, configure .env, and start it.
#
# No domain is required. Every Cloudways app already gets a working HTTPS
# "Application URL" out of the box (Cloudways issues and renews its
# certificate for you, no certbot needed) — that's enough to reach WaGuard.
# Attaching your own domain later is a one-click change in the Cloudways
# console (Domain Management + SSL Certificate tabs), not something this
# script needs to know about.
#
# Cloudways deploys the code itself (its UI's Git deployment feature, over an
# SSH key you manage there) — this script does NOT clone or pull anything.
# Run it FROM INSIDE the already-deployed app directory (the folder that has
# package.json, .env.example, etc. — typically
# /home/master/applications/<app>/public_html), over SSH, as the Cloudways
# master user:
#
#   cd /home/master/applications/<app>/public_html
#   ./scripts/provision-cloudways.sh
#
# It opens a menu:
#   1) Dry run  — checks everything and logs what WOULD happen; makes no
#                 changes to the system. Tells you up front whether Apply
#                 is likely to succeed or where it will fail.
#   2) Apply    — does the real, one-time setup: Node (via nvm if there's no
#                 sudo, via NodeSource if there is) + build tools, PM2
#                 (installed locally under the master user, no root needed
#                 for that part), npm install/build, .env with production
#                 settings, PM2 start + boot persistence. Safe to re-run
#                 (idempotent).
#   3) Exit
#
# No sudo? No problem for Node itself — nvm installs it entirely under
# $HOME/.nvm. The one thing that genuinely needs root is the C++ toolchain
# (build-essential/python3) that better-sqlite3 compiles against; if it's
# missing and you have no sudo, the script tells you exactly what to ask
# Cloudways support for.
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
#   2. mod_proxy / mod_proxy_http enabled on the server (needed by the
#      repo's .htaccess) — Cloudways support needs to flip this on, per
#      their own guide linked above. If the app doesn't respond through the
#      Application URL after apply, this is the first thing to check.
#   3. Attaching a custom domain + issuing SSL for it, if you want one
#      instead of the default Application URL — both are one-click in the
#      Cloudways console, not SSH-reachable.
#   4. build-essential/python3, if missing and you have no sudo — ask
#      Cloudways support to install them.
# ------------------------------------------------------------------------
#
# Configure via environment variables (all optional):
#   NODE_PORT        default: 3000 — must match the port in the repo's
#                     root .htaccess if you ever change it from the default.
#   PUBLIC_BASE_URL  default: unset — set this once you know your app's URL
#                     (the Cloudways-issued Application URL, or your own
#                     domain once attached), e.g. https://wa.example.com.
#                     Used to build absolute inbound-media URLs in webhook
#                     payloads. Also controls COOKIE_SECURE (see below).
#   COOKIE_SECURE    default: true if PUBLIC_BASE_URL starts with https://,
#                     otherwise false. Override explicitly if needed.
#
# Example:
#   PUBLIC_BASE_URL=https://wa.example.com ./scripts/provision-cloudways.sh --apply

set -uo pipefail

# ---- config ---------------------------------------------------------------
NODE_PORT="${NODE_PORT:-3000}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
COOKIE_SECURE="${COOKIE_SECURE:-}"
if [ -z "$COOKIE_SECURE" ]; then
  case "$PUBLIC_BASE_URL" in
    https://*) COOKIE_SECURE="true" ;;
    *) COOKIE_SECURE="false" ;;
  esac
fi
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
HAVE_SUDO=1
if [ -n "$SUDO" ] && ! sudo -n true 2>/dev/null; then
  HAVE_SUDO=0
fi

# ---- validate inputs --------------------------------------------------
step "Validating configuration"
if [ -z "$PUBLIC_BASE_URL" ]; then
  info "PUBLIC_BASE_URL not set — will leave it unset in .env for now."
  info "Find your app's URL in the Cloudways console (Application -> Access"
  info "Details -> Application URL), then re-run with PUBLIC_BASE_URL=<url>"
  info "or set it directly in .env afterwards."
else
  ok "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
fi
ok "COOKIE_SECURE=$COOKIE_SECURE"

step "Checking this is a deployed WaGuard app directory"
if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/.env.example" ]; then
  fail_now "No package.json/.env.example in $APP_DIR. cd into the app directory Cloudways deployed the code into (its Git deployment feature), then re-run."
fi
ok "found package.json + .env.example in $APP_DIR"

step "Checking the reverse-proxy file deployed with the repo"
if [ -f "$APP_DIR/.htaccess" ]; then
  ok ".htaccess present (deployed by Cloudways Git deploy, no action needed)"
  if ! grep -q "127.0.0.1:${NODE_PORT}" "$APP_DIR/.htaccess"; then
    issue ".htaccess doesn't reference port ${NODE_PORT} — if you changed NODE_PORT from the default, update .htaccess to match and redeploy."
  fi
else
  issue "No .htaccess in $APP_DIR — the repo's root .htaccess should have been deployed by Cloudways Git deploy. Without it, Apache won't proxy requests to Node."
fi

# ---- Node.js ----------------------------------------------------------
# Prefer NodeSource+apt when sudo is available (system-wide, simplest);
# fall back to nvm (installs under $HOME/.nvm, no root needed) otherwise.
step "Node.js 20"
NODE_OK=0
if command -v node >/dev/null 2>&1 && [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -ge 20 ]; then
  ok "Node $(node -v) already installed"
  NODE_OK=1
  # sharp (image handling) needs >=20.9.0 specifically; older 20.x still
  # works today (npm just warns), but flag it since it's an easy nvm fix.
  NODE_MINOR="$(node -v | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')"
  if [ "$NODE_MINOR" -lt 9 ] 2>/dev/null; then
    info "Node $(node -v) is below 20.9.0 — sharp will print an EBADENGINE warning on install (non-fatal). Run 'nvm install 20' for a current 20.x if you want it silenced."
  fi
fi
NVM_SH="$HOME/.nvm/nvm.sh"
if [ "$NODE_OK" -eq 0 ] && [ -s "$NVM_SH" ]; then
  # shellcheck disable=SC1090
  . "$NVM_SH"
  if command -v node >/dev/null 2>&1 && [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -ge 20 ]; then
    ok "Node $(node -v) already installed via nvm"
    NODE_OK=1
  fi
fi
if [ "$MODE" = "dry-run" ]; then
  if [ "$NODE_OK" -eq 0 ]; then
    if [ "$HAVE_SUDO" -eq 1 ]; then
      info "[DRY-RUN] would install Node 20.x via NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_20.x -o /dev/null || issue "Can't reach deb.nodesource.com — check outbound network/DNS."
    else
      info "[DRY-RUN] no sudo — would install Node 20.x via nvm (\$HOME/.nvm, no root needed)"
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh -o /dev/null || issue "Can't reach raw.githubusercontent.com to fetch the nvm installer — check outbound network/DNS."
    fi
  fi
else
  if [ "$NODE_OK" -eq 0 ]; then
    if [ "$HAVE_SUDO" -eq 1 ]; then
      run_step "install Node 20.x" bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - && $SUDO apt-get install -y nodejs"
    else
      run_step "install nvm" bash -c "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
      # shellcheck disable=SC1090
      . "$NVM_SH"
      run_step "install Node 20.x via nvm" nvm install 20
    fi
  fi
  node -v; npm -v
fi

# ---- native build toolchain (needed by better-sqlite3) --------------------
step "C++ build toolchain (gcc/g++/make/python3)"
TOOLCHAIN_OK=1
for tool in gcc g++ make python3; do
  command -v "$tool" >/dev/null 2>&1 || TOOLCHAIN_OK=0
done
if [ "$TOOLCHAIN_OK" -eq 1 ]; then
  ok "gcc/g++/make/python3 all present"
elif [ "$HAVE_SUDO" -eq 1 ]; then
  run_step "install build-essential python3" $SUDO apt-get install -y build-essential python3
else
  issue "gcc/g++/make/python3 not all present, and there's no sudo to install build-essential/python3. Ask Cloudways support to install them — npm install will fail compiling better-sqlite3 without them."
fi

# ---- PM2 (per-user install, no root required — matches Cloudways' guide) --
step "PM2"
PM2_BIN_DIR="$HOME/.waguard-npm-global/bin"
if command -v pm2 >/dev/null 2>&1; then
  ok "PM2 already installed ($(pm2 -v))"
  PM2_CMD="pm2"
elif [ -x "$PM2_BIN_DIR/pm2" ]; then
  ok "PM2 already installed under $PM2_BIN_DIR ($("$PM2_BIN_DIR/pm2" -v))"
  PM2_CMD="$PM2_BIN_DIR/pm2"
else
  PM2_CMD="$PM2_BIN_DIR/pm2"
  if [ "$MODE" = "dry-run" ]; then
    info "[DRY-RUN] would run: npm config set prefix $HOME/.waguard-npm-global && npm install -g pm2 (no sudo — installed under the master user's home dir, per Cloudways' Node.js guide)"
  else
    run_step "npm config set prefix" npm config set prefix "$HOME/.waguard-npm-global"
    run_step "install PM2 (no sudo)" npm install -g pm2
    if ! grep -qF "$PM2_BIN_DIR" "$HOME/.bashrc" 2>/dev/null; then
      echo "export PATH=\"\$PATH:$PM2_BIN_DIR\"" >>"$HOME/.bashrc"
      info "added $PM2_BIN_DIR to PATH in ~/.bashrc — source it or start a new shell to use 'pm2' directly"
    fi
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
  # npm install --dry-run above didn't actually install anything, so there's
  # no local tsc yet — running it via npx would try to fetch an unrelated
  # abandoned npm package literally called "tsc" and fail. Only check if a
  # real install already happened (e.g. a previous apply).
  if [ -x "$APP_DIR/node_modules/.bin/tsc" ]; then
    if "$APP_DIR/node_modules/.bin/tsc" --noEmit -p tsconfig.json 2>/tmp/tsc-dry.$$; then
      ok "TypeScript compiles cleanly (tsc --noEmit)"
    else
      issue "TypeScript fails to compile — npm run build would fail. See below:"
      cat /tmp/tsc-dry.$$
    fi
    rm -f "/tmp/tsc-dry.$$"
  else
    info "node_modules not installed yet (dry-run doesn't install) — skipping compile check; 'npm install' + 'npm run build' on apply will validate this."
  fi
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
  set_env COOKIE_SECURE "$COOKIE_SECURE" "$TMP_ENV"
  [ -n "$PUBLIC_BASE_URL" ] && set_env PUBLIC_BASE_URL "$PUBLIC_BASE_URL" "$TMP_ENV"
  grep -qE "^SESSION_SECRET=.+" "$TMP_ENV" || set_env SESSION_SECRET "<generated-on-apply>" "$TMP_ENV"
  info "[DRY-RUN] .env diff that would be applied:"
  diff -u "${TMP_ENV}.orig" "$TMP_ENV" || true
  rm -f "$TMP_ENV" "${TMP_ENV}.orig"
else
  [ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  set_env PORT "$NODE_PORT" "$APP_DIR/.env"
  set_env COOKIE_SECURE "$COOKIE_SECURE" "$APP_DIR/.env"
  [ -n "$PUBLIC_BASE_URL" ] && set_env PUBLIC_BASE_URL "$PUBLIC_BASE_URL" "$APP_DIR/.env"
  grep -qE "^SESSION_SECRET=.+" "$APP_DIR/.env" || set_env SESSION_SECRET "$(openssl rand -hex 32)" "$APP_DIR/.env"
  ok ".env written"
fi

# ---- PM2 --------------------------------------------------------------------
step "PM2 process (start/restart + boot persistence)"
if [ "$MODE" = "dry-run" ]; then
  if "$PM2_CMD" describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    info "[DRY-RUN] would run: $PM2_CMD restart $PM2_APP_NAME --update-env"
  else
    info "[DRY-RUN] would run: $PM2_CMD start $APP_DIR/dist/server.js --name $PM2_APP_NAME"
  fi
  info "[DRY-RUN] would run: $PM2_CMD save && $PM2_CMD startup systemd (+ the sudo command it prints) && $PM2_CMD save"
else
  if "$PM2_CMD" describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    run_step "pm2 restart" "$PM2_CMD" restart "$PM2_APP_NAME" --update-env
  else
    run_step "pm2 start" "$PM2_CMD" start "$APP_DIR/dist/server.js" --name "$PM2_APP_NAME"
  fi
  run_step "pm2 save" "$PM2_CMD" save
  if [ "$HAVE_SUDO" -eq 1 ]; then
    STARTUP_CMD="$("$PM2_CMD" startup systemd -u "$(whoami)" --hp "$HOME" | grep -E '^sudo ' || true)"
    if [ -n "$STARTUP_CMD" ]; then
      run_step "pm2 startup" bash -c "$STARTUP_CMD"
    else
      info "pm2 startup already configured or nothing to do"
    fi
    run_step "pm2 save (after startup)" "$PM2_CMD" save
  else
    info "no sudo available — skipping 'pm2 startup' (boot persistence). Run it manually later if you get sudo access, or ask Cloudways to keep the box from rebooting unexpectedly."
  fi
fi

# ---- verify (apply mode only — dry-run changed nothing to verify) ---------
if [ "$MODE" = "apply" ]; then
  step "Verifying"
  sleep 2
  if curl -fsSI "http://127.0.0.1:${NODE_PORT}" >/dev/null 2>&1; then
    ok "http://127.0.0.1:${NODE_PORT} (Node, direct) is responding"
  else
    issue "http://127.0.0.1:${NODE_PORT} did not respond — check: $PM2_CMD logs $PM2_APP_NAME"
  fi
  if curl -fsSI "http://127.0.0.1/" >/dev/null 2>&1; then
    ok "http://127.0.0.1/ (Apache proxy) is responding — .htaccess + mod_proxy are working"
  else
    issue "http://127.0.0.1/ did not respond through Apache — check mod_proxy is enabled (see the earlier step) and that .htaccess deployed correctly."
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
    echo " APPLY COMPLETE — WaGuard should now be live at your Cloudways"
    echo " Application URL (console -> Application -> Access Details)."
  else
    echo " APPLY COMPLETE WITH $ISSUES WARNING(S) — see above."
  fi
  if [ -z "$PUBLIC_BASE_URL" ]; then
    echo " Reminder: PUBLIC_BASE_URL wasn't set — set it in .env once you"
    echo " know your app's URL, then: pm2 restart $PM2_APP_NAME --update-env"
  fi
  echo " To deploy future code changes: Cloudways Git-deploy the update,"
  echo " then from this directory run: ./scripts/deploy.sh"
fi
echo " Full log: $LOG_FILE"
echo "================================================================"
[ "$ISSUES" -gt 0 ] && exit 1
exit 0

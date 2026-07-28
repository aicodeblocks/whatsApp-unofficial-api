#!/usr/bin/env bash
# Stops the PM2-managed WaGuard process to free CPU/RAM without losing its
# PM2 registration (config, env, logs stay put — a plain restart brings it
# back). Run this ON THE SERVER, from the app directory:
#   ./scripts/stop.sh
# Pass --delete to remove it from PM2 entirely instead (need
# `pm2 start dist/server.js --name waguard`, or ./scripts/deploy.sh, to
# bring it back afterwards).
set -euo pipefail

cd "$(dirname "$0")/.."

# provision-cloudways.sh installs PM2 under $HOME (no root needed), which
# isn't on PATH in a non-interactive shell — fall back to that full path.
if command -v pm2 >/dev/null 2>&1; then
  PM2_CMD="pm2"
else
  PM2_CMD="$HOME/.waguard-npm-global/bin/pm2"
fi

if [ "${1:-}" = "--delete" ]; then
  "$PM2_CMD" delete waguard
else
  "$PM2_CMD" stop waguard
fi
"$PM2_CMD" save

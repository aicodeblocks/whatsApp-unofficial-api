#!/usr/bin/env bash
# Rebuilds and reloads the PM2-managed process after Cloudways has already
# deployed the new code (via its own Git-deployment UI / SSH key) — this
# script does NOT pull anything itself.
# Run this ON THE SERVER, from the app directory (e.g. .../public_html):
#   ./scripts/deploy.sh
# See docs/DEPLOY_CLOUDWAYS.md for setup, or scripts/provision-cloudways.sh
# for a one-shot script that does the initial setup this assumes already happened.
set -euo pipefail

cd "$(dirname "$0")/.."

npm install
npm run build
npm prune --omit=dev

# provision-cloudways.sh installs PM2 under $HOME (no root needed), which
# isn't on PATH in a non-interactive shell — fall back to that full path.
if command -v pm2 >/dev/null 2>&1; then
  PM2_CMD="pm2"
else
  PM2_CMD="$HOME/.waguard-npm-global/bin/pm2"
fi

# restart if already registered; otherwise start it (e.g. process was wiped
# by a reboot before pm2's boot-persistence kicked in).
"$PM2_CMD" restart waguard --update-env || "$PM2_CMD" start dist/server.js --name waguard
"$PM2_CMD" save

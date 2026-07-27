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

# restart if already registered; otherwise start it (e.g. process was wiped
# by a reboot before pm2's boot-persistence kicked in).
pm2 restart waguard --update-env || pm2 start dist/server.js --name waguard
pm2 save

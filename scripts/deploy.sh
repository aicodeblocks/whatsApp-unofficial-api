#!/usr/bin/env bash
# Pulls the latest code, rebuilds, and reloads the PM2-managed process.
# Run this ON THE SERVER, from the project root (e.g. ~/waguard):
#   ./scripts/deploy.sh
# See docs/DEPLOY_CLOUDWAYS.md for setup, or scripts/provision-cloudways.sh
# for a one-shot script that does the initial setup this assumes already happened.
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
npm install
npm run build
npm prune --omit=dev

pm2 restart waguard --update-env
pm2 save

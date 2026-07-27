#!/usr/bin/env bash
# Pulls the latest code, rebuilds, and reloads the PM2-managed process.
# Run this ON THE SERVER, from the project root (e.g. ~/waguard):
#   ./scripts/deploy.sh
# See docs/DEPLOY_CLOUDWAYS.md and docs/DEPLOY_CLOUDWAYS_SIMPLE.md for setup.
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
npm install
npm run build
npm prune --omit=dev

pm2 restart waguard --update-env
pm2 save

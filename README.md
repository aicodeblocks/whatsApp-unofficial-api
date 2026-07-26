# WaGuard — Self-Hosted WhatsApp API

A pure, headless WhatsApp API service. Link your own existing WhatsApp number by QR (like WhatsApp Web) and send/receive messages via a token-secured API — no Meta Cloud API, no Business account, no third-party provider. Anti-ban pacing and health monitoring are the primary design goal.

> **Note:** This uses the unofficial WhatsApp Web protocol, which is against WhatsApp's Terms of Service. There is inherent ban risk; WaGuard minimizes it but cannot eliminate it.

## Run with Docker (recommended)

Only Docker needs to be installed on the host.

```bash
cp .env.example .env      # optional — sensible defaults work as-is
docker compose up --build
```

Then open <http://localhost:3000>. On first launch you'll create an admin password.

All persistent data (SQLite database, session secret, and — in later milestones — WhatsApp sessions and media) lives in `./data`, so it survives restarts and rebuilds.

## Run without Docker (fallback)

Requires Node.js 20+.

```bash
npm install
npm run dev        # development, auto-reload
# or
npm run build && npm start
```

## What's here (Milestone 1)

- Admin dashboard with first-run password setup and login.
- Create / revoke **API tokens**; all API calls require `Authorization: Bearer <token>`.
- A token-protected sample endpoint: `GET /api/v1/status`.
- Live, auto-generated **API docs** at `/docs` and a downloadable spec at `/openapi.json`.

Later milestones add: linking WhatsApp numbers, safe sending with anti-ban pacing, receiving via webhooks, and health & consent monitoring. See `_build_plan/prd.md`.

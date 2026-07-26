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

## Authentication

Every `/api/v1/...` call requires an API token:

```
Authorization: Bearer <token>
```

Create a token in the dashboard (**API Tokens → Create token**). The value is shown once — copy it. Tokens can be revoked anytime. The admin dashboard pages (`/login`, `/numbers`, …) use a separate session-cookie login and are the built-in UI only; a downstream app never calls them.

Explore and try everything at **`/docs`** (grouped as **system**, **numbers**, and **dashboard (internal)**). Click **Authorize**, paste a token, then use **Try it out** on any endpoint. The machine-readable spec is at **`/openapi.json`**.

## What's here (Milestone 1) — Foundation & Access

- Admin dashboard with first-run password setup and login.
- Create / revoke **API tokens**; all API calls require `Authorization: Bearer <token>`.
- A token-protected sample endpoint: `GET /api/v1/status`.
- Live, auto-generated **API docs** at `/docs` and a downloadable spec at `/openapi.json`.

## What's here (Milestone 2) — Link a Number

Link your own WhatsApp number(s) by scanning a QR code (exactly like WhatsApp Web), from either the dashboard **or** entirely through the API. Linked numbers auto-reconnect after a restart; sessions persist under `./data/sessions/`.

### Number API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/numbers` | Create a number and start the QR linking flow. Body: `{ "label": "..." }`. Returns the number with its `id`. |
| `GET` | `/api/v1/numbers/{id}/qr` | **The QR endpoint (JSON).** Returns `{ status, qr, phone }`. `qr` is a PNG **data-URI** to embed/display while `status` is `connecting`; becomes `null` once `linked`. Best for programmatic use. |
| `GET` | `/api/v1/numbers/{id}/qr.png` | **The QR as a scannable image.** Same QR served as raw `image/png` you can view/scan directly. Auth via Bearer header **or** `?token=<token>` query so the URL opens in a browser tab. (One-shot — does not auto-refresh.) |
| `GET` | `/api/v1/numbers/{id}/qr/live` | **Auto-refreshing QR page.** A standalone HTML page that polls and refreshes the QR (and flips to "linked" on scan) — exactly like the dashboard, but openable in any browser with `?token=<token>`. |
| `GET` | `/api/v1/numbers` | List all numbers and their status. |
| `GET` | `/api/v1/numbers/{id}` | Get one number and its status. |
| `POST` | `/api/v1/numbers/{id}/relink` | Restart the QR flow for a disconnected number. |
| `DELETE` | `/api/v1/numbers/{id}` | Log out and remove the number. |

A number's `status` is one of: `connecting`, `linked`, `disconnected`, `flagged`.

### How a downstream app links a number (step by step)

**Step 1 — Create the number.** The downstream app calls:

```bash
curl -X POST http://localhost:3000/api/v1/numbers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"label":"Support line"}'
# → 201 { "id": "abc-123", "status": "connecting", "phone_number": null, ... }
```

Save the returned `id` (e.g. `abc-123`). You must use a **real** id from this response in the next step — a made-up id returns `404 { "error": "not_found" }`.

**Step 2 — Fetch the QR and show it to the number's owner.**

```bash
curl http://localhost:3000/api/v1/numbers/abc-123/qr \
  -H "Authorization: Bearer <token>"
# → 200 { "status": "connecting",
#         "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEU...",
#         "phone": null }
```

The `qr` field **is** the QR image. Display it directly — no image processing needed:

```html
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEU..." />
```

**Want to just see/scan the QR without writing any HTML?** Use the image variant, which returns a raw PNG:

- In **Swagger `/docs`**: open `GET /api/v1/numbers/{id}/qr.png`, click **Authorize** (paste a token), **Try it out**, put in your real `id`, **Execute** — the scannable QR renders right in the response.
- Or open it **directly in a browser tab** (handy for scanning on screen):
  `http://localhost:3000/api/v1/numbers/<id>/qr.png?token=<token>`
  (One-shot image — reload to refresh. Note: a token in a URL can end up in logs — fine for local linking, prefer the header in production.)
- **Best for scanning by hand:** open the **auto-refreshing page** in a browser — it refreshes the QR and shows "linked" on scan, just like the dashboard:
  `http://localhost:3000/api/v1/numbers/<id>/qr/live?token=<token>`

The number's owner opens **WhatsApp → Settings → Linked Devices → Link a device** and scans it.

**Step 3 — Poll until linked.** Call `GET /api/v1/numbers/abc-123/qr` every ~2 seconds:

- Not scanned yet → `status: "connecting"` with a fresh `qr` each time (it rotates as it expires).
- Scanned → `status: "linked"`, `qr: null`, `phone: "1555..."`. Stop polling — the number is ready.

**Step 4 — Send from that number.** Use the number's `id` with the messaging API (see Milestone 3 below).

> Prefer the built-in UI? The dashboard **Numbers** page does the same create → QR → poll flow for you. The API exists so a downstream system (e.g. a CRM) can offer its own linking screen without the dashboard.

Later milestones add: receiving via webhooks, and health & consent monitoring. See `_build_plan/prd.md`.

## What's here (Milestone 3) — Safe Sending

Send **text, image, document, audio, and video** messages from a linked number. Every send is routed through an **anti-ban queue** that paces it like a real person — randomized delays, a typing indicator before sending, per-number daily limits with a warm-up ramp, and overnight quiet hours — then tracks its status from `queued` to `delivered`/`read`.

### Messaging API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/messages` | **Send a message** (text, or media by URL). Returns `202 { message_id, status: "queued", scheduled }`. |
| `POST` | `/api/v1/messages/upload` | Send a media message from an **uploaded file** (`multipart/form-data`, file part named `file`). |
| `GET` | `/api/v1/messages/{id}` | Get a message and its current status. |
| `GET` | `/api/v1/messages` | List recent messages (filter with `?number_id=`). |
| `GET` | `/api/v1/numbers/{id}/queue` | Queue snapshot for a number: paused flag, per-state counts, pending/failed jobs. |
| `POST` | `/api/v1/numbers/{id}/pause` · `/resume` | Pause or resume a number's outbound queue. |

A message's `status` is one of: `queued`, `sent`, `delivered`, `read`, `failed`.

**Send a text message:**

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{ "number_id": "abc-123", "to": "15551234567", "type": "text", "content": "Hello 👋" }'
# → 202 { "message_id": "…", "status": "queued", "scheduled": false }
```

**Media by URL** — set `"type": "image"` (or `document`/`audio`/`video`) with `"media_url": "https://…"` and an optional `"caption"`. **Uploaded file** — `POST /api/v1/messages/upload` as multipart with fields `number_id`, `to`, `type`, optional `caption`/`schedule_at`, and a `file` part. **Schedule** — add `"schedule_at": "2026-08-01T09:00:00Z"` (ISO-8601) to any send.

Then poll `GET /api/v1/messages/{id}` to watch the status advance. The dashboard **Send & Queue** page offers a test-send form, live per-number queue counts, pause/resume, and retry-failed.

### Anti-ban tuning (optional env vars)

Safe defaults ship out of the box. Override in `.env` if needed: `SEND_DELAY_MIN_MS`/`SEND_DELAY_MAX_MS` (inter-send delay), `TYPING_BASE_MS`/`TYPING_PER_CHAR_MS`/`TYPING_MAX_MS` (typing sim), `DAILY_LIMIT_MAX`, `WARMUP_RAMP` (comma list, e.g. `20,40,80,120,160,200`), `QUIET_HOURS_ENABLED`/`QUIET_START_HOUR`/`QUIET_END_HOUR`/`QUIET_TZ`, `SEND_MAX_ATTEMPTS`, `SEND_RETRY_BACKOFF_MS`, `QUEUE_TICK_MS`.

> Receiving inbound replies and status webhooks arrive in Milestone 4 — WaGuard is send-only until then.

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

All persistent data (SQLite database, session secret, WhatsApp sessions, and downloaded media) lives in `./data`, so it survives restarts and rebuilds.

## Run without Docker (fallback)

Requires Node.js 20+.

```bash
npm install
npm run dev        # development, auto-reload
# or
npm run build && npm start
```

## Deploying on Cloudways

Cloudways has no native Node.js stack, but WaGuard runs well on a Cloudways
**PHP Application** server's underlying VPS via PM2 + Nginx reverse proxy —
see [`docs/DEPLOY_CLOUDWAYS.md`](docs/DEPLOY_CLOUDWAYS.md) for the full guide.
`scripts/provision-cloudways.sh` automates the entire initial setup in one
run (with a log file); `scripts/deploy.sh` automates rebuild-and-restart for
updates after that.

No domain yet, or don't need HTTPS? See
[`docs/DEPLOY_CLOUDWAYS_IP.md`](docs/DEPLOY_CLOUDWAYS_IP.md) and
`scripts/provision-cloudways-ip.sh` for an IP-only path (plain HTTP, no
Nginx/SSL).

## Authentication

Every `/api/v1/...` call requires an API token:

```
Authorization: Bearer <token>
```

Create a token in the dashboard (**API Tokens → Create token**). The value is shown once — copy it. Tokens can be revoked anytime. The admin dashboard pages (`/login`, `/numbers`, …) use a separate session-cookie login and are the built-in UI only; a downstream app never calls them.

Explore and try everything at **`/docs`** (grouped as **system**, **numbers**, **messages**, **contacts**, **health**, and **dashboard (internal)**). Click **Authorize**, paste a token, then use **Try it out** on any endpoint — the token is remembered across page reloads. The machine-readable spec at **`/openapi.json`** covers every endpoint **and** the webhook payload shapes.

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

### How Safe Sending protects your number

The single most important design goal is keeping your number safe. A message you submit is **never fired instantly** — it's queued and released the way a human would send it. Each of these behaviours is applied automatically to every outbound message:

- **Randomized human delays.** A random gap (default **6–25s**) is inserted between consecutive sends on the same number, so there's never a machine-gun burst. The exact delay is chosen fresh for every message.
- **One message at a time, per number.** Sends on a number are serialized with a cooldown after each — never parallel blasts. The queue releases at most one message per number at a time.
- **Typing simulation.** Right before each message, the number shows **"typing…"** for a realistic, length-proportional time (short text ≈ 1–2s, long text up to ~9s), then stops, then the message goes out — mirroring the rhythm of a real person typing and hitting send.
- **Per-number daily limits + warm-up ramp.** A brand-new number starts small (**~20 messages/day**) and climbs gradually over about a week (`20 → 40 → 80 → 120 → 160 → 200 → …` up to a full ceiling of 250/day). Sudden high volume from a fresh number is one of the biggest flag triggers, so it's avoided by design. When the daily cap is hit, further messages wait for the next day.
- **Quiet hours.** No sends overnight (default **21:00–08:00**, server-local or a configured timezone). Messages queued during quiet hours are **held** and released automatically in the morning — humans don't blast messages at 3am.
- **Burst / rate throttling.** The randomized cooldown plus one-release-at-a-time together guarantee no rapid bursts, even if you enqueue hundreds of messages at once.
- **Friendly connection footprint.** The number does not force itself "online" on connect, and presents a stable desktop-WhatsApp fingerprint.
- **Gentle failure handling.** A failed send retries with a backoff (default up to 3 attempts) instead of hammering, then records the failure reason.
- **Recipient validation.** Obviously malformed numbers are rejected before anything is queued.
- **Pause / resume + durable queue.** You can pause a number's queue at any time; queued and scheduled messages survive a service restart, and anything interrupted mid-send is picked back up automatically.

**More on the friendly connection footprint.** This is about the signals WhatsApp sees from *how your device connects and presents itself* — separate from what you send or how fast. WhatsApp's abuse detection watches connection and device patterns, not just message volume, so WaGuard keeps that footprint unremarkable (see `src/whatsapp/manager.ts`):

- **It doesn't force your account "online" on connect** (`markOnlineOnConnect: false`). On connect, the underlying library *can* immediately announce your whole account as "online/active" and broadcast presence to your contacts. WaGuard turns that off, so linking or auto-reconnecting doesn't repeatedly flip your account online, doesn't blast presence to everyone, and doesn't leave your number in an **always-online** state — a bot-like tell, since a real person's phone goes idle and sleeps. (This is the *account-wide* online broadcast — different from the per-recipient **"typing…"** indicator during a send, which is shown deliberately, only to the person you're messaging.)
- **It presents a stable, ordinary desktop-client identity** (`Browsers.macOS('Chrome')`). Every linked device registers a "browser/platform" descriptor — what you see under **Settings → Linked Devices** on your phone (e.g. *"Chrome (macOS)"*). WaGuard uses a **consistent, normal desktop fingerprint** rather than a random or odd string, so WhatsApp sees the **same device identity across every reconnect** (a shifting or unusual fingerprint looks suspicious) and it mimics a normal WhatsApp Web / Desktop client — the most common, least-remarkable way to be linked.
- **Reinforced by session persistence.** Because credentials are saved and reused (Milestone 2), a reconnect is the **same device coming back**, not a brand-new link each time. Frequent re-linking / re-registration is itself a danger sign, so avoiding that churn keeps the footprint clean.

Put together, a number that connects quietly, doesn't force itself always-online, keeps one stable device identity, and rarely re-links looks like an ordinary person's linked desktop. **Scale check:** these are **minor contributors** next to the big levers (pacing, daily volume, warm-up, recipient quality) — they won't move the needle much alone, but they're free, sensible defaults that avoid obvious bot tells.

> **Reality note:** this uses the unofficial WhatsApp Web protocol, so these measures **reduce** ban risk as far as technically possible — they cannot make it zero. (Health monitoring and consent guardrails in Milestone 5 reduce it further.)

**About the "typing…" indicator (what the recipient sees).** When WaGuard shows "typing…", WhatsApp displays it **live** at the top of the chat on the recipient's phone (the person you sent to) — exactly as if a person were typing — a second or a few before your message arrives. Then "typing…" stops and the message lands. It is **live and ephemeral** — not stored:

- **Chat open** on the recipient's screen when the message goes out → they see "typing…", then the message. ✅ (It can also appear as "typing" under the chat name in their chat list.)
- **App closed / phone locked / on a different chat** → the typing state already passed, so they never see it; they simply receive the message and its notification.

To see it yourself, keep the recipient phone with that chat **open** while you send — you'll watch "typing…" appear briefly right before the text lands. Note that showing "typing…" does reveal your number is active to **that one recipient** during the send — this is **intentional** (it's what makes the send look human) and is only ever shown to the person you're messaging, never broadcast to anyone else.

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

## What's here (Milestone 4) — Receiving & Webhooks

WaGuard now **receives**: messages sent to a linked number are captured and stored, incoming media is downloaded, and everything is **pushed to your systems via signed webhooks** — along with delivery/read status updates for your outbound messages. Receiving is webhook-**push** (there's no polling API for history; stored messages are still listable).

### Webhook events

Configure a single endpoint on the dashboard **Webhooks** page: set the URL, choose which events to receive, toggle it active, and see a live log of recent deliveries (status, HTTP code, attempts, errors). A strong signing secret is generated for you (reveal / regenerate), and a **Send test event** button verifies your receiver.

| Event | Fires when |
| --- | --- |
| `message.inbound` | A message is received by a linked number (text/image/video/audio/document). |
| `message.status` | An outbound message advances: `sent` → `delivered` → `read`, or `failed`. |

Every webhook is an HTTP `POST` with a JSON envelope `{ event, timestamp, data }`, and these headers:

```
X-WaGuard-Event:     message.inbound
X-WaGuard-Delivery:  <delivery id>
X-WaGuard-Timestamp: <ISO-8601>
X-WaGuard-Signature: sha256=<hmac>
```

**Verify authenticity** by computing `HMAC-SHA256(secret, raw_request_body)` and comparing it (hex) to the `X-WaGuard-Signature` value after the `sha256=` prefix. If your endpoint is down, deliveries are **retried automatically** with exponential backoff (nothing is silently lost).

Inbound `message.inbound` payloads include a `media_url` for any attached media — an authenticated download link (see below) — and `is_stop: true` when the message body is a STOP-style opt-out (which auto-blocks the contact in Milestone 5).

### New API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/messages/{id}/media` | Download a message's stored media (inbound or uploaded). Bearer token required. Inbound webhook `media_url`s point here. |
| `GET` | `/api/v1/messages?direction=inbound\|outbound` | The messages list now filters by `direction` (stacks with `number_id`) — a convenience view of received vs sent. |

> Set **`PUBLIC_BASE_URL`** in production (e.g. `https://wa.example.com`) so the `media_url` in webhook payloads is reachable by your receiver. Webhook delivery is tunable via `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BACKOFF_MS`, `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_TICK_MS`.

## What's here (Milestone 5) — Health & Consent

Completes the anti-ban story with **live health monitoring** and **consent guardrails**, plus API-docs polish.

### Health monitoring & auto cool-down

Every number carries a live health signal — **healthy / at-risk / flagged** — shown on the new dashboard **Health** page (with a per-number activity snapshot and a danger-sign event timeline). WaGuard watches for trouble on its own: unexpected disconnects, WhatsApp re-login (logged-out) prompts, and spikes in failed/undelivered messages. When a number trends bad it reacts automatically:

- **At-risk** → the anti-ban engine **slows it down** (longer gaps + a reduced daily ceiling).
- **Flagged** → the number enters a labelled **cool-off**: it's held out of use for a computed rest period that **escalates with each repeat offence**, and the dashboard recommends routing sends through a different number until it recovers. It recovers automatically once the cool-off passes and signals clear.

Health transitions are also pushed to your webhook as a **`health.event`** (subscribe on the Webhooks page).

### Consent guardrails

Each contact has a consent status — **opted-in / unknown / blocked**. **Sends to a blocked contact are refused** (`recipient_blocked`); unknown contacts follow a configurable policy (`CONSENT_UNKNOWN_POLICY`, default `allow`). When someone replies **STOP** (or UNSUBSCRIBE/CANCEL/…) to your number, that contact is **auto-blocked** and won't be messaged again. And right before a real send, WaGuard checks the recipient is actually on WhatsApp — if not, the message is failed with `not_on_whatsapp` instead of wasting a send. Browse and manage all of this on the searchable dashboard **Contacts** page (opt-in / block / unblock).

### New API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/contacts` | List / search contacts (`?search=`, `?status=opted_in\|unknown\|blocked`). |
| `GET` | `/api/v1/contacts/{id}` | Get one contact. |
| `POST` | `/api/v1/contacts/consent` | Set consent **by phone** (upserts the contact). Body: `{ phone, consent_status, source }`. |
| `POST` | `/api/v1/contacts/{id}/consent` | Set consent **by id**. Body: `{ consent_status, source }`. |
| `GET` | `/api/v1/numbers/{id}/health` | A number's live health: status, cool-off window, activity snapshot, recent events. |
| `GET` | `/api/v1/health/events` | The health-event timeline (filter with `?number_id=`). |

**Mark a recipient opted-in:**

```bash
curl -X POST http://localhost:3000/api/v1/contacts/consent \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{ "phone": "15551234567", "consent_status": "opted_in", "source": "web_form" }'
```

### Health & consent tuning (optional env vars)

`CONSENT_UNKNOWN_POLICY` (`allow`/`block`), `HEALTH_WINDOW_MIN`, `HEALTH_MIN_VOLUME`, `HEALTH_ATRISK_RATIO`, `HEALTH_FLAG_RATIO`, `HEALTH_DISCONNECT_ATRISK`, `HEALTH_ATRISK_SLOWDOWN`, `HEALTH_COOLOFF_BASE_MIN`, `HEALTH_COOLOFF_MAX_MIN`, `HEALTH_COOLOFF_ESCALATE_WINDOW_MIN`. See `.env.example` for defaults.

---

**All five milestones are shipped — WaGuard v1 is feature-complete.** A v2 plan (dashboard redesign, downstream developer portal + live API console, contact import, templates, buttons, broadcasts, groups, analytics) lives in `_build_plan/v2/`.

---

# WaGuard v2 — Dashboard, Developer Portal & Scale

v2 turns the working v1 service into a polished product surface and adds the deferred functional features. It ships in 5 milestones (`_build_plan/v2/`): **1** design system & dashboard shell · **2** developer portal (docs + live API console) · **3** contacts import + templates + buttons · **4** broadcasts + group messaging · **5** analytics & reporting.

## What's here (v2 · Milestone 1) — Design system, branded shell & Overview

A professional visual foundation applied to **every** dashboard page, plus a live Overview home that reflects the true state of everything the service does. No new API/functional surface — this is the shell later v2 milestones render inside.

### The branded shell & design system

- A cohesive **design system** — emerald-on-zinc palette as CSS tokens, refreshed cards, buttons, pills, tables, and page headers — so every page looks like one product.
- A branded **top header** on every page: WaGuard logo mark + wordmark, a live **"N linked"** connection indicator, a **light/dark theme toggle**, and an account menu (API tokens, API docs, log out).
- A refined **icon left-navigation** covering every area (Overview, Numbers, Send & Queue, Contacts, Webhooks, Health, API Tokens, API Docs), with Templates / Broadcasts / Analytics shown as **"Soon"** (they activate in v2 M3–M5).
- A **branded footer** showing the app version (from `package.json`) and links to API Docs, Health, and status.
- A persistent **light/dark theme** that follows the operating-system preference by default and remembers an explicit toggle choice (`localStorage`), with no flash-of-wrong-theme on load.
- A **responsive** layout that holds down to tablet/phone width — the sidebar collapses behind a menu button.

### The Overview home

Opening the dashboard now shows live status at a glance:

- A **system-health strip**: numbers linked, queue depth, at-risk numbers, and webhook delivery health.
- A **status card per capability** (Numbers, Send & Queue, Receiving, Webhooks, Health, Contacts) — each with a real count and an **active / idle / needs-attention** status dot.
- **Quick actions** (link a number, send a test, open docs, configure webhooks).
- A **recent-activity feed** merging the latest sent/received messages, health events, and webhook deliveries.

### Notes for maintainers

- No new endpoints or env vars. The whole shell is server-rendered EJS; all styling stays inline in `src/views/partials/head.ejs` (no static-asset serving added).
- Shared shell data (`appName`, `appVersion`, `numberCount`, `linkedCount`) is injected into every view by a single global `onRequest` hook in `src/server.ts` via `reply.locals` — individual routes don't pass it.
- **Local run caveat:** `npm run dev` (tsx) fails on some hosts because a Baileys 7 transitive WASM dependency (`whatsapp-rust-bridge`) only exposes an ESM `import` condition that Node's CJS resolver rejects. Use the compiled path instead — `npm run build && node dist/server.js` — which is exactly what the Docker image runs.

## What's here (v2 · Milestone 2) — Developer portal: docs + interactive API console

A human-friendly API reference at **`/developers`**, distinct from the raw Swagger UI (`/docs`, still available), plus a live "try it" console — all generated straight from the same OpenAPI document the API already produces, so the docs can't drift from the real endpoints.

- **Getting started** — create a token (links to API Tokens), the service's base URL, and a first curl call.
- **Endpoint reference** grouped by area (System, Numbers, Messages, Contacts, Health), each endpoint an expandable row with its description, a path/query parameter table, a request-body example, and a copyable curl snippet. A search box filters the list.
- **Webhooks section** — field tables for each webhook payload shape (`WebhookMessageInbound`/`Status`/`HealthEvent`) plus a signature-verification code snippet (HMAC-SHA256 of the raw body).
- **Interactive console** — pick an endpoint (grouped `<select>`), fill in path/query params and an editable JSON body, paste a token (remembered in `localStorage`), and **Send** a real same-origin request; the response panel shows status, latency, and pretty-printed JSON. The multipart upload endpoint and binary QR/media endpoints are documented with a working curl snippet but excluded from the console (no clean JSON round-trip).
- The sidebar/footer/account-menu "API Docs" links now point to `/developers`; the Overview page's docs card links there too, with the raw Swagger UI and spec download kept as secondary actions.

### Notes for maintainers

- No new endpoints, dependencies, or env vars. `src/routes/dashboard/portal.ts` builds the whole view model from `app.swagger()` at request time (grouping by tag, walking each operation's parameters/requestBody, and deriving a JSON example from each body schema) — it reuses the exact schemas already declared on every route in `src/routes/api/*.ts`.
- The portal route (`GET /developers`) is public, same posture as `/docs` — downstream developers won't have an admin session.
- The console is vanilla JS embedded in `src/views/portal.ejs` (no build step, no client dependency) — the endpoint list it needs is embedded server-side as a `<script type="application/json">` blob.

## What's here (v2 · Milestone 3) — Contacts & content: import + lists + templates + buttons

CSV contact import into named lists, contact lists/segments, a reusable template library with `{{placeholders}}`, and interactive buttons on templates and the single-send form.

- **CSV contact import** on the Contacts page: upload a CSV — phone/name/consent columns are auto-detected by header name — and see a validation preview flagging invalid phone numbers and duplicates before anything is saved; confirm to import the valid rows into a chosen or new named list.
- **Contact lists / segments**: create named lists, add/remove any contact to/from a list inline, and filter the Contacts table by list alongside the existing consent filter.
- **Template library** (new `/templates` page): create/edit/delete templates with `{{name}}`/`{{phone}}` placeholders, an optional media attachment (file or URL), and a live preview that substitutes sample values as you type.
- **Interactive buttons** (quick-reply / call / link, up to 3): attachable to a template or directly to a single-send message. **WhatsApp reality check, live-verified**: classic native buttons are silently discarded by WhatsApp's servers for personal (non-Business-API) numbers — a raw `buttonsMessage` send succeeds with a real message id and no error, but nothing is ever delivered to the device. Buttons therefore render as a clean numbered text list appended to the message (e.g. "1. Yes / 2. No / 3. Call support — call +1555…") — confirmed **delivered** end-to-end against a real phone. Button metadata (type/label/payload) is still fully stored and exposed via the dashboard and templates API for any downstream system that wants to render real interactive UI itself.
- The Send & Queue test-send form gained a "use a template" picker (auto-fills text/media/buttons) and its own ad-hoc buttons section.
- A basic templates API (`GET/POST /api/v1/templates`, `GET/PUT/DELETE /api/v1/templates/:id`) — it showed up in the `/developers` portal automatically.
- **WaGuard does not interpret replies** to the numbered list (e.g. a reply of "1") — that's intentionally out of scope; inbound replies land as ordinary text via the existing webhook pipeline, and it's the downstream app's job to give them meaning.

### Notes for maintainers

- New tables: `contact_lists`, `contact_list_members`, `contact_imports`, `templates` (includes a `media_type` column so a template with media knows which Baileys content shape to build), and one polymorphic `buttons` table (`owner_type: 'template'|'message'`) shared by templates and single-send messages instead of two parallel tables. `messages` gained a nullable `template_id`.
- `src/db/templates.ts`'s `fillPlaceholders()` is the one placeholder-substitution implementation — reuse it rather than re-implementing `{{}}` replacement (e.g. for M4 broadcasts).
- CSV import preview is stateless: valid rows round-trip through a hidden `rows_json` form field between the preview and confirm steps, no server-side session state.
- Adding a route under a **brand-new** API tag (like `templates` here) needs one line each in `src/routes/dashboard/portal.ts`'s `TAG_ORDER`/`TAG_LABELS` for it to show up on `/developers` — routes added under an already-listed tag need nothing.
- **Test-data isolation:** never copy `data/sessions/` when making an isolated host test-data directory — it holds live WhatsApp auth state, and a copied session can make a host test process attempt a second live connection as the same linked device.

## What's here (v2 · Milestone 4) — Sending at scale: broadcasts + group messaging

Bulk broadcast campaigns to a contact list and WhatsApp group messaging, both routed through the exact same anti-ban queue, pacing, health, and consent systems as a single send — not a parallel send path.

- **Broadcast campaigns** (new `/broadcasts` page): build a campaign — name, sending number, target contact list, a saved template or inline text/media, optional buttons, optional future start time — and save it as a **draft** first. The draft view shows a recipient-count preview and an estimated send window under the number's current daily pacing limit before you commit anything.
- **Launch, watch, and control**: launching fans the campaign out to every eligible recipient, paced like a single send. Live progress (queued/sent/delivered/read/failed) auto-refreshes; **pause**, **resume**, or **cancel** at any point. Blocked and consent-unknown contacts (per your policy) are automatically skipped and counted.
- **WhatsApp group messaging**: sync the groups a linked number belongs to (with participant counts) and send a text, media, or templated message to any of them — through the same paced queue, buttons rendering as the same numbered-text-list fallback M3 established. Groups are **not** individually consent-tracked Contacts — no `{{placeholder}}` fill, no per-recipient consent check.
- **Inbound group messages are now captured** (previously silently dropped), correctly attributed to the actual sending participant (not the group), flagged `is_group: true`, and pushed via the same `message.inbound` webhook. One deliberate exception: a "STOP" keyword typed inside a group chat does **not** auto-block that person's direct messages — a group opt-out isn't a personal one.
- A **Broadcasts API and a Groups API** (`/api/v1/broadcasts/*`, `/api/v1/groups/*`) — a deliberate break from M3's dashboard-only precedent — let downstream systems create/launch/control campaigns and sync/send to groups programmatically, auto-documented in `/developers`.

### Notes for maintainers

- `messages.contact_id` had to become **nullable** (group messages have no individual contact) — SQLite can't relax a `NOT NULL` via `ALTER TABLE`, so `src/db/migrations.ts`'s `ensureMessagesContactIdNullable()` does a one-time guarded table rebuild on upgrade (no-op on fresh installs).
- New tables: `broadcast_campaigns`, `groups`. `messages` gained nullable `group_id`/`broadcast_id`.
- The natural reuse point for fanning out a campaign is `enqueueMessage()` itself (`src/whatsapp/broadcast.ts`'s `launchCampaign()`) — it already does consent/validation/template/placeholder handling in one call; broadcasts just loop it per recipient and count thrown `EnqueueError`s as skips, rather than re-implementing any of that logic.
- Group sends go through a sibling `enqueueGroupMessage()` in `src/whatsapp/enqueue.ts` that shares template-resolution logic with `enqueueMessage()` but skips contact/consent entirely.
- `src/whatsapp/queue.ts`'s worker gained a campaign pause/cancel gate and branches on `message.group_id` vs `message.contact_id` in `releaseSend` — group sends skip the `existsOnWhatsApp` presence check (not applicable to a group JID).

## What's here (v2 · Milestone 5) — Analytics & reporting

Date-range charts, KPI tiles, and CSV export — closing out v2. Built entirely on data v1–M4 already produce; nothing here changes send behavior.

- A new **Analytics page** (date range + number filter, defaults to the last 30 days): KPI tiles (sent, delivery rate, read rate, failures, inbound), a sends-over-time chart (stacked by status), an inbound-volume chart, a health-incidents-over-time chart (stacked by severity), a per-number breakdown (chart + table), and a campaign-performance table.
- **CSV export** of the selected range's per-number daily stats.
- A read-only **Analytics API** (`/api/v1/analytics/summary|daily|campaigns|health`) mirroring the dashboard's data, auto-documented in `/developers`.
- Charts are **hand-rolled inline SVG** with vanilla JS — no charting library was added, keeping the app dependency-light (no CDN calls anywhere in WaGuard, consistent with the inline-SVG icons and hand-rolled CSV parser already in the codebase).

### Notes for maintainers

- New table `daily_stats` — a per-number/per-day **cache** of message counts (`src/db/analytics.ts`), not a source of truth; it's lazily filled the first time a date range is viewed (`ensureDailyStatsFor()`) and read from cache thereafter, the same self-healing-on-read pattern M4's `refreshCampaignStatus()` uses. A 3-day "settle window" (today + the last 2 days) is always computed live, never cached, since anti-ban pacing/health cool-off can leave a message `queued` for a while past its creation day.
- Day-bucketing is **display-timezone-aware** (`dateKeyInTz()` in `src/time.ts`), not UTC — a message's day bucket matches the operator's actual calendar day under `APP_TZ`, not a UTC-shifted one.
- Message counts are bucketed by **current status** using `created_at`, not a status-transition event log (none exists) — "delivered on day X" means "created on day X and currently delivered," consistent with how the existing `activitySnapshot()` health helper already reasons about message counts.
- `campaignPerformanceInRange()` batches the **existing** `campaignProgress()` from M4's `db/broadcasts.ts` — no new per-campaign counting logic was written.

# Milestone 5 — Health & Consent

## What's new in the app

- **Live health status for every number** — a new **Health** page shows each linked number as *healthy*, *at-risk*, or *flagged*, with a recent-activity summary (sends, failures, failure %) and a full danger-sign event timeline.
- **Early-warning detection** — WaGuard now watches for trouble on its own: unexpected disconnects, WhatsApp re-login (logged-out) prompts, and spikes in failed/undelivered messages. Each is logged with a snapshot of what was happening at the time.
- **Automatic cool-down & rest periods** — an *at-risk* number is automatically slowed (longer gaps, a lower daily ceiling). A *flagged* number is put into a labelled **cool-off**: it's held out of use for a computed rest period (which gets longer each time it re-offends), and the dashboard tells you to route sends through a different number until it recovers. It recovers automatically once the cool-off passes and things look healthy again.
- **Consent guardrails** — every contact has a consent status (opted-in / unknown / blocked). **Sends to a blocked contact are refused.** Unknown contacts follow a configurable policy (allow by default).
- **Auto-block on "STOP"** — when someone replies STOP/UNSUBSCRIBE/etc. to your number, that contact is automatically blocked and won't be messaged again.
- **A searchable Contacts page** — browse/search recipients by phone or name, filter by consent, and opt-in / block / unblock with one click.
- **Consent API** — downstream apps can mark a recipient opted-in or blocked (with a recorded source) by phone or by id, and list/search contacts.
- **Non-WhatsApp numbers no longer waste a send** — right before sending, WaGuard checks the recipient is actually on WhatsApp; if not, the message is marked failed (`not_on_whatsapp`) without burning a real send.
- **Health webhooks** — a new `health.event` webhook pushes risk transitions (at-risk / flagged / cool-off / recovered, with the activity snapshot) to your endpoint so downstream systems learn about danger early. It appears automatically in the Webhooks page event list.
- **Polished API docs** — the docs page keeps your token across reloads (Authorize + Try-it-out enabled), and the OpenAPI spec now documents all endpoints **and** the three webhook payload shapes. Version bumped to `1.0.0`.

## What was built

### Data model (`src/db/migrations.ts`, `src/db/numbers.ts`, `src/db/health.ts`, `src/db/contacts.ts`)
- New table **`health_events`**: `id, number_id, event_type, severity, snapshot (JSON string), notes, created_at`, indexed on `(number_id, created_at)` and `(number_id, event_type, created_at)`.
- New columns on `whatsapp_numbers` (idempotent ALTERs): **`health_status`** (`healthy`|`at_risk`|`flagged`, default `healthy`) and **`cooloff_until`** (ISO string, nullable — while in the future the number is resting).
- `src/db/numbers.ts` — `HealthStatus` type; `setHealthStatus`, `setCooloffUntil`, `inCooloff(row)` helpers; `WhatsAppNumber` interface extended.
- `src/db/health.ts` (new) — event CRUD (`insertHealthEvent`, `listHealthEvents`, `countEventsSince`) and **`activitySnapshot(numberId, windowMinutes)`** which aggregates outbound volume / sent / delivered-or-read / failed / failure_ratio / last_send_at from the `messages` table.
- `src/db/contacts.ts` — `setConsent(id, status, source)`, `setConsentByPhone(phone, status, source)` (upserts), `listContacts(search?, status?, limit)`.

### Health engine (`src/whatsapp/health.ts`, new)
- `recordSignal(numberId, type, severity, notes)` — logs a raw danger signal with a snapshot, emits a `health.event` webhook, then re-evaluates.
- `evaluateHealth(numberId)` — rule-based status derivation over a trailing window (`HEALTH_WINDOW_MIN`, default 60m):
  - `relogin` event in window **or** failure_ratio ≥ `HEALTH_FLAG_RATIO` (with ≥ `HEALTH_MIN_VOLUME` sends) → **flagged**.
  - ≥ `HEALTH_DISCONNECT_ATRISK` disconnects **or** failure_ratio ≥ `HEALTH_ATRISK_RATIO` → **at_risk**.
  - otherwise → **healthy**.
  - On a *new* flag it opens a **cool-off**: `HEALTH_COOLOFF_BASE_MIN` doubled per prior cool-off within `HEALTH_COOLOFF_ESCALATE_WINDOW_MIN`, capped at `HEALTH_COOLOFF_MAX_MIN`; logs `flagged` + `cooloff` events (with a "switch to another number" recommendation) and fires a webhook carrying `cooloff_until` / `cooloff_minutes` / `recommend_switch_number`.
  - A flagged number stays flagged while resting; once the cool-off elapses and signals clear it logs `recovered` and returns to healthy.
- `refreshHealth(numberId)` — used by the queue so an elapsed cool-off can recover.
- `AT_RISK_SLOWDOWN` exported (default 3×).

### Anti-ban wiring (`src/whatsapp/queue.ts`, `src/whatsapp/manager.ts`)
- `manager.ts` — on connection close: `loggedOut` → `recordSignal('relogin','critical')`; any non-`restartRequired` transient drop → `recordSignal('disconnect','warning')` (the normal 515 after pairing is ignored). New method **`existsOnWhatsApp(numberId, phone)`** using `sock.onWhatsApp` (returns `true`/`false`, or `null` = "couldn't tell, don't block").
- `queue.ts` `processJob` — refreshes health, then: **cool-off hold** (defer with reason `cooloff` until the window ends, jittered); at-risk numbers get a **reduced daily ceiling** (`limit / AT_RISK_SLOWDOWN`). `releaseSend` — a **non-WhatsApp recipient** (`existsOnWhatsApp === false`) is failed with `not_on_whatsapp` (no real send, no webhook status "sent"); the post-send cooldown is multiplied by `AT_RISK_SLOWDOWN` while at-risk; a finalized send failure calls `evaluateHealth` (failure-spike detection).

### Consent (`src/whatsapp/enqueue.ts`, `src/whatsapp/inbound.ts`)
- `enqueue.ts` — after resolving the contact: `blocked` → `EnqueueError('recipient_blocked')`; `unknown` + `CONSENT_UNKNOWN_POLICY=block` → `EnqueueError('consent_required')`; default policy `allow`.
- `inbound.ts` — an inbound STOP-style keyword now sets the contact `consent_status='blocked'`, `consent_source='inbound_stop'` (enforcement, complementing M4's detect-and-flag).

### Webhooks (`src/db/webhooks.ts`, `src/whatsapp/webhooks.ts`)
- `WEBHOOK_EVENTS` gains **`health.event`** (auto-appears in the dashboard checkbox list). New `emitHealth(numberId, event, status, extra?)` + `healthPayload(...)` builder (snapshot parsed to an object, `*_local` timestamp, optional cool-off fields).

### API (`src/routes/api/contacts.ts`, `src/routes/api/health.ts`, new; `src/server.ts`)
- Contacts: `GET /api/v1/contacts` (search + status filter), `GET /api/v1/contacts/:id`, `POST /api/v1/contacts/consent` (by phone, upsert), `POST /api/v1/contacts/:id/consent` (by id). Tag `contacts`.
- Health: `GET /api/v1/numbers/:id/health` (status, cool-off, `in_cooloff`, `recommend_switch_number`, snapshot, recent events), `GET /api/v1/health/events`. Tag `health`.

### Dashboard (`src/routes/dashboard/contacts.ts`, `.../health.ts`, `src/views/contacts.ejs`, `.../health.ejs`, `partials/head.ejs`, `numbers.ejs`)
- `/contacts` — searchable/filterable table with opt-in / block / unblock actions (`POST /contacts/:id/consent`).
- `/health` — per-number health table (health pill, cool-off "· N h left" pill + rest-until note, recent-activity counts) and a health-events timeline.
- Nav: **Contacts** and **Health** are now real links (were "soon"). The Numbers page shows an at-risk / cooloff / flagged badge per number.

### Docs (`src/plugins/swagger.ts`)
- `contacts` + `health` tags; `components.schemas` documents `WebhookEnvelope`, `WebhookMessageInbound`, `WebhookMessageStatus`, `WebhookHealthEvent`; info description explains signing + Try-it-out; Swagger-UI `persistAuthorization` + `tryItOutEnabled`; API version → `1.0.0`.

### Config (`.env.example`)
- Documented: `CONSENT_UNKNOWN_POLICY`, `HEALTH_WINDOW_MIN`, `HEALTH_MIN_VOLUME`, `HEALTH_ATRISK_RATIO`, `HEALTH_FLAG_RATIO`, `HEALTH_DISCONNECT_ATRISK`, `HEALTH_ATRISK_SLOWDOWN`, `HEALTH_COOLOFF_BASE_MIN`, `HEALTH_COOLOFF_MAX_MIN`, `HEALTH_COOLOFF_ESCALATE_WINDOW_MIN`.

## Decisions made during implementation (not pre-specified in the PRD)

- **Cool-off as an explicit, escalating, labelled rest period** (per the user's steer on the plan question). A flag doesn't just "slow" the number — it's held out of use for a computed duration that **doubles with each repeat offence** (base 60m → cap 24h) within a look-back window, and the dashboard/webhook explicitly recommend switching to another number. This is the "feedback mechanism decides how long, don't let us use that number" behaviour requested.
- **Health status is a separate column from connection status.** `status` stays the connection lifecycle (linked/connecting/disconnected/flagged from M2); `health_status` is the independent anti-ban signal. Keeping them separate avoids interfering with the reconnect logic.
- **Unknown-consent policy default = `allow`** (chosen with the user). Blocked is always refused; unknown is allowed unless `CONSENT_UNKNOWN_POLICY=block`. Keeps normal usage working when downstream hasn't recorded consent yet.
- **Non-WhatsApp check happens at send time in the queue** (chosen with the user), not at API-call time — so the API doesn't require the sending number to be linked/reachable at the moment of the call. A `null` lookup result (number not linked / lookup error) does **not** block the send (fail-open on an inconclusive check).
- **Failure-spike detection is pull-based off the `messages` table** via `activitySnapshot`, rather than a separate counter — it reuses the durable status history already written by M3/M4, so it survives restarts and needs no new bookkeeping.
- **`health.event` is a single event type** carrying `event_type`/`severity`/`health_status` rather than many webhook types — simpler subscription, and the existing dispatcher/signing/retry/log all work unchanged.
- **At-risk auto-cool-down = 3× slower + ⅓ daily ceiling** (`HEALTH_ATRISK_SLOWDOWN`), a single knob for both the inter-send gap and the daily limit.

## Verification (against the "Done when" criteria)

Automated in-process suite `scratchpad/verify-m5.mjs` — **19/19 passing** against the compiled code in an isolated temp DATA_DIR:
- Consent: unknown allowed by default; **blocked send rejected** (`recipient_blocked`); opt-in re-allows; consent source recorded; contact search + status filter. ✅
- **Auto-block on inbound STOP** via `handleInbound` (`consent_status=blocked`, `source=inbound_stop`), and a subsequent send is refused. ✅
- **Health flag + cool-off on re-login**: number → `flagged`, `cooloff_until` set in the future, `relogin`+`flagged`+`cooloff` events logged, flag event carries an activity snapshot, notes recommend switching numbers. ✅
- First cool-off ≈ base (60m). ✅
- **Recovery**: after the cool-off elapses (and the signal ages out of the window) the number returns to `healthy`, cool-off cleared, `recovered` event logged. ✅
- **Failure-spike → flagged**: 70% failure ratio over 10 sends flags the number. ✅

HTTP smoke test (host): `POST /api/v1/contacts/consent` blocks a contact; `GET /api/v1/contacts?status=blocked` returns it; `GET /api/v1/numbers/:id/health` and `GET /api/v1/health/events` respond; no-token → 401; `/contacts` + `/health` redirect unauthenticated to `/login`. Authenticated render: `/contacts`, `/health` (shows "cooloff · 1 h left", flagged/critical/relogin), and the `/numbers` cooloff badge all render with no EJS errors.

**Docker (deployment target):** image builds; a throwaway container (isolated volume, port 3996) boots clean, exposes all M5 endpoints + the four `Webhook*` schemas in `/openapi.json`, and consent/health endpoints work inside the container. The live `waguard` container was left untouched — rebuild it with `docker compose up -d --build` (preserves `./data`) to deploy M5.

## Anything a follow-up will need to know

- **This is the last planned milestone.** `_build_plan/` is a temporary artifact and can be deleted once M5 is shipped.
- **Health is rule-based and env-tuned** (see `healthCfg` in `src/whatsapp/health.ts` and the `HEALTH_*` vars). No ML / auto-tuning (explicitly out of scope for v1). All the raw evidence is in `health_events` for later learning.
- **Cool-off recovery is queue-driven**: `processJob` calls `refreshHealth` each time it considers a job, so a number recovers on its next due job after the cool-off. A number with no queued jobs stays flagged in the table until something triggers an evaluation — cosmetic only (it isn't sending anyway).
- **Consent is global** (single-tenant), not per-number — as the PRD scopes for v1.

## Deviations from the PRD

- None functional. Everything in the M5 "Done when" is implemented. Additions beyond the literal spec (all requested/agreed): the explicit escalating **cool-off** rest state with a switch-number recommendation, and the `health.event` webhook (the PRD's "fired to the webhook when a number trends toward risk").

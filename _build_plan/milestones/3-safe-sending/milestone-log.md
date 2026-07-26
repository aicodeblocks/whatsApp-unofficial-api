# Milestone 3 — Safe Sending · Log

## What's new in the app

- **Send messages over the API.** A new send endpoint lets any downstream app send **text, image, document, audio, and video** messages from a linked number. Media can be a **URL the service fetches** or an **uploaded file**.
- **Every send is paced like a human.** Messages don't fire instantly — they flow through an anti-ban queue that adds randomized delays, shows a **typing indicator** before sending, respects **per-number daily limits**, ramps up new numbers with a **warm-up schedule**, and holds sends during **quiet hours** (overnight by default).
- **Track every message.** Each send returns a message id and a live status you can poll: **queued → sent → delivered → read** (or **failed** with a reason).
- **Schedule sends for later.** Ask for a message to go out at a specific future time and the queue releases it then.
- **New "Send & Queue" dashboard page.** Send a test message, watch each number's queue (waiting / processing / sent / failed), see the daily-limit counter, **pause or resume** a number's queue, and **retry failed** messages — with a recent-messages table that auto-refreshes as statuses change.
- **The queue is durable.** Queued and scheduled messages survive a service restart, and anything interrupted mid-send is automatically picked back up.
- **Recipient validation.** Obviously malformed recipient numbers are rejected before anything is queued.

## What was built

**New dependency:** `@fastify/multipart` (^9) — for uploaded-file media sends.

**Files created:**
- `src/db/contacts.ts` — the `contacts` table data access: `resolveContact` (find-or-create by phone, default consent `unknown`), `getContact`, `getContactByPhone`, `markContacted`. (Consent is stored but **not enforced** — that's Milestone 5.)
- `src/db/messages.ts` — data access for `messages` and `queued_jobs`: create/get/list messages, status transitions (`markMessageSent`, `advanceMessageStatus` with a monotonic rank so status never moves backwards, `markMessageFailed`), and the job lifecycle (`createJob`, `dueWaitingJobs`, `setJobState`, `rescheduleJob` (bumps attempts), `deferJob` (hold without an attempt), `failJob`, `jobCountsForNumber`, `jobsForNumber`, `resetStuckJobs`, `retryFailedForNumber`).
- `src/whatsapp/pacing.ts` — the pure anti-ban engine: `randomSendDelayMs`, `typingDurationMs` (length-proportional), `dailyLimitFor` (warm-up ramp → full ceiling), `isQuietHours` / `quietHoldUntil` (timezone-aware), `todayStr`. All parameters env-configurable with conservative defaults.
- `src/whatsapp/media.ts` — `buildContent(message)` turns a stored message into the Baileys `sendMessage` payload (text; media from disk bytes for uploads or `{ url }` for links; per-type mimetype/filename inference).
- `src/whatsapp/enqueue.ts` — `enqueueMessage(input)` shared by API + dashboard: validates recipient (`normalizePhone`, 8–15 digits) and required fields, resolves the contact, creates the message + job, honors `schedule_at`. Throws typed `EnqueueError`.
- `src/whatsapp/queue.ts` — the queue worker. A single non-overlapping interval (`startQueue`/`stopQueue`) drains due `waiting` jobs, **one release per number per tick**. Per job it checks, in order: queue-paused → quiet-hours → number-linked → daily-limit → per-number cooldown, then runs the typing simulation (`composing` → wait → `paused`) and sends. Success advances the message and arms a randomized cooldown; failure retries with linear backoff up to `SEND_MAX_ATTEMPTS`, then marks failed. Holds use `deferJob` so they never burn retry attempts. `resetStuckJobs()` on boot recovers anything left `processing`.
- `src/routes/api/messages.ts` — the send/track API (see endpoints below).
- `src/routes/dashboard/queue.ts` + `src/views/queue.ejs` — the Send & Queue dashboard page.

**Files changed:**
- `src/db/migrations.ts` — added `contacts`, `messages`, `queued_jobs` tables (+ indexes) and, via an idempotent `addColumnIfMissing` helper, the anti-ban columns on `whatsapp_numbers` (`warmup_started_at`, `daily_sent_count`, `daily_count_date`, `queue_paused`). The ALTER approach upgrades existing M2 databases in place.
- `src/db/numbers.ts` — extended `WhatsAppNumber` with the new columns and added `setQueuePaused`, `ensureWarmupStarted`, `recordDailySend` (with date rollover), `dailyCountFor`.
- `src/whatsapp/manager.ts` — added `phoneToJid`, and public `isLinked(id)`, `sendPresence(id, jid, state)`, `sendMessage(id, jid, content)` (returns WhatsApp's message id). Wired a `messages.update` / `message-receipt.update` listener that maps the provider message id back to our row and advances delivery/read status (`mapProviderStatus`).
- `src/server.ts` — registered `@fastify/multipart`, the message API routes and queue dashboard routes, and calls `startQueue()` after listen.
- `src/plugins/swagger.ts` — added the `messages` docs tag.
- `src/views/partials/head.ejs` — the "Send & Queue" nav item is now a real link.
- `package.json` / `package-lock.json` — `@fastify/multipart`.

**Endpoints added:**
- API (Bearer): `POST /api/v1/messages` (text or media-by-URL; `202 {message_id, status:'queued', scheduled}`), `POST /api/v1/messages/upload` (multipart file), `GET /api/v1/messages/:id`, `GET /api/v1/messages`, `GET /api/v1/numbers/:id/queue`, `POST /api/v1/numbers/:id/pause`, `POST /api/v1/numbers/:id/resume`.
- Dashboard (session): `GET /queue`, `POST /queue/send`, `POST /queue/:id/pause`, `POST /queue/:id/resume`, `POST /queue/:id/retry`.

## Decisions made during implementation (not pre-specified in the PRD)

- **Anti-ban parameters are global env-configurable constants** (in `pacing.ts`), not per-number DB settings — with conservative defaults so a fresh install is safe with zero tuning. Per-number state that the PRD *does* model (warm-up stage, daily count, pause) lives on `whatsapp_numbers`. Keys: `SEND_DELAY_MIN_MS`/`MAX_MS`, `TYPING_BASE_MS`/`PER_CHAR_MS`/`MAX_MS`, `DAILY_LIMIT_MAX`, `WARMUP_RAMP` (comma list), `QUIET_HOURS_ENABLED`/`QUIET_START_HOUR`/`QUIET_END_HOUR`/`QUIET_TZ`, `SEND_MAX_ATTEMPTS`, `SEND_RETRY_BACKOFF_MS`, `QUEUE_TICK_MS`.
- **Pacing model = per-number cooldown + one-release-per-tick.** Rather than a per-number worker thread, a single interval releases at most one message per number each tick and arms an in-memory cooldown (`randomSendDelayMs`) after each send. This serializes sends per number and spaces them out while staying simple and restart-safe (cooldown is in-memory and simply re-derives after a restart).
- **Delivery/read status is driven by Baileys `messages.update`**, matched via `provider_message_id`. Baileys' numeric `WAMessageStatus` (2/3/4/5) is mapped to sent/delivered/read; `advanceMessageStatus` uses a rank so out-of-order acks can't regress a status.
- **Quiet-hours release time is computed from the local hour/minute** (optionally in `QUIET_TZ`) plus small jitter, rather than constructing a fully tz-aware future `Date` — avoids DST edge bugs and is precise enough to hold overnight and release in the morning.
- **Media source:** uploaded files are read into a Buffer and sent as bytes; URL media is passed to Baileys as `{ url }` (Baileys fetches). Uploaded files are stored under `data/media/<uuid><ext>` on the volume. `media_path` is internal and never exposed in API responses.
- **Daily limit / warm-up:** `warmup_started_at` is stamped on the number's **first-ever send**; the day index since then indexes the `WARMUP_RAMP` (default `20,40,80,120,160,200`, then `DAILY_LIMIT_MAX`=250). Limit-reached jobs are deferred ~30 min (the day rolls over and resets the counter).
- **Auth ordering caveat:** API routes keep the established `preHandler: requireApiToken` pattern. Fastify runs body-schema validation before the preHandler, so a request that is *both* unauthenticated *and* malformed returns `400` (validation) rather than `401`. A well-formed unauthenticated request correctly returns `401`. Not changed to preserve consistency with the M1/M2 routes; worth revisiting globally if strict 401-first is desired.

## Verification (against the "Done when" criteria)

Verified on an isolated host instance (auth/validation/enqueue/queue logic) **and end-to-end against a real WhatsApp recipient** using the linked Docker number (`15513423891` → recipient `919663291144`):

- **Send text** → `queued → sent → delivered` with a real provider message id; delivered to the recipient. ✅
- **Send media (image by URL)** → `queued → delivered → read` (recipient opened it); caption delivered. ✅
- **Human pacing + typing indicator** — messages sat `queued` for the pacing/typing window before going out, not instant. ✅
- **Status → delivered/read** — both transitions observed via the provider status listener. ✅
- **Scheduled send** — `schedule_at` in the future returns `scheduled:true` and the job's `scheduled_send_at` is set to that time (held until then). ✅
- **Pause / resume** — API and dashboard both flip `queue_paused`; a paused number's jobs are held. ✅
- **Recipient validation** — too-short/long recipients rejected with `invalid_recipient`; missing text/media rejected. ✅
- **Quiet hours** — with the default window active locally, an immediate job was held (`deferJob`, `last_error=quiet_hours`) with `attempts` staying 0; disabling via `QUIET_HOURS_ENABLED=false` released it. ✅
- **Queue durability** — jobs persist in SQLite on the volume; `resetStuckJobs()` returns interrupted `processing` jobs to `waiting` on boot. Migration ALTERed the existing M2 database in place (warm-up columns added, linked number reconnected without re-scan). ✅

0 server errors in logs across the runs (the only 400s were the intentional validation tests).

## What the next milestone (4 — Receiving & Webhooks) needs to know

- **Inbound is not wired yet.** The manager currently listens to `connection.update`, `creds.update`, and `messages.update`/`message-receipt.update` (outbound status only). M4 adds a `messages.upsert` listener for **incoming** messages, stores them as `messages` rows with `direction='inbound'` (the column and table already support it), downloads inbound media to `data/media/`, and fires webhooks.
- **Reuse the `messages` + `contacts` tables.** Inbound messages resolve/create a contact via `resolveContact` and insert with `direction='inbound'`. Add inbound-oriented columns only if needed (e.g. a `from`/timestamp) — most fields already exist.
- **Webhook status events** should hook the same status transitions the manager already computes (`advanceMessageStatus`) — fire `sent/delivered/read/failed` webhooks from there (or from the queue on send/fail).
- **The "STOP" keyword** detection (M4) feeds M5 consent; `contacts.consent_status`/`consent_source` are already in place to be flipped to `blocked`.
- **Media storage** convention is `data/media/<uuid><ext>`; `media_path` is the internal on-disk pointer (kept out of API responses) — mirror it for inbound.
- Follow the established patterns: schema'd `/api/v1` routes (auto-docs), `requireApiToken` for API, `requireAdmin` for dashboard, EJS shell.

## Deviations from the PRD

- **Anti-ban tuning is global (env), not per-number** — see decisions. Per-number *state* the PRD models is present; per-number *policy* is intentionally deferred (the PRD itself notes v1 is rule-based with global settings, and Milestone 5 explicitly scopes consent policy as global too).
- **Burst/rate throttling** is realized as the randomized per-number cooldown between sends plus one-release-per-tick, rather than a separate token-bucket — same effect (no bursts), simpler.
- No functional scope was dropped; text + both media input methods (URL and upload), scheduling, pause/resume, retry, and durable queue are all implemented.

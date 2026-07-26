# Milestone 4 — Receiving & Webhooks

## What's new in the app

- **Incoming messages are captured.** Any WhatsApp message sent to a linked number is now received and stored (text, image, video, audio, document), with the sender saved as a contact.
- **Incoming media is downloaded** to the data volume and made available to your systems through an authenticated download link.
- **A Webhooks page** in the dashboard: set your endpoint URL, choose which events to receive (incoming messages and/or outbound status updates), toggle it active, and see a live log of recent deliveries with status, HTTP code, attempts, and errors.
- **Signed webhook events** fire in real time for incoming messages (`message.inbound`) and for every outbound status change (`message.status`: sent / delivered / read / failed). Each request is HMAC-SHA256 signed with your secret so you can verify it's genuinely from WaGuard.
- **Auto-generated signing secret** with reveal and one-click regenerate, plus a **"Send test event"** button to verify your receiver without waiting for a real message.
- **Reliable delivery:** if your endpoint is down, events are retried automatically with exponential backoff and nothing is silently lost.
- **"STOP"-style opt-out keywords** on incoming messages are detected and flagged in the webhook payload (`is_stop: true`), ready for the consent handling in Milestone 5.

## What was built

### Data model (`src/db/migrations.ts`, `src/db/webhooks.ts`)
- New tables:
  - `webhook_endpoints` — id, url, secret, events (csv), active, timestamps. Single endpoint in v1 (table supports more).
  - `webhook_deliveries` — durable delivery log: id, endpoint_id, event_type, payload (JSON string, signed as-is), status (`pending`/`success`/`failed`), attempts, response_code, last_error, next_attempt_at, timestamps, delivered_at. Indexed on `(status, next_attempt_at)` for the worker and on `created_at` for the recent list.
- `src/db/webhooks.ts` — endpoint CRUD (`getEndpoint`, `saveEndpoint`, `rotateSecret`, `generateSecret`, `endpointWants`) and delivery CRUD (`createDelivery`, `duePendingDeliveries`, `recentDeliveries`, `markDeliverySuccess/Retry/Failed`). `WEBHOOK_EVENTS = ['message.inbound','message.status']`.
- `src/db/messages.ts` — added `createInboundMessage` (inserts `direction='inbound'`, `status='delivered'`) and made `advanceMessageStatus` **return a boolean** (whether the status actually advanced) so callers only fire a webhook on a real transition.

### Webhook dispatcher + worker (`src/whatsapp/webhooks.ts`)
- `emitInbound(message, isStop)` and `emitMessageStatus(messageId, status)` build the payload envelope `{ event, timestamp, data }` and, if the endpoint is active and subscribed, write a delivery row and nudge the worker.
- A single non-overlapping worker (`startWebhookWorker`/`stopWebhookWorker`, interval `WEBHOOK_TICK_MS`) drains due `pending` deliveries. Each attempt POSTs the stored JSON body with headers `X-WaGuard-Event`, `X-WaGuard-Delivery`, `X-WaGuard-Timestamp`, and `X-WaGuard-Signature: sha256=<hmac>`. 2xx → success; otherwise retry with exponential backoff (`WEBHOOK_RETRY_BACKOFF_MS` doubling, capped at `WEBHOOK_MAX_BACKOFF_MS`) up to `WEBHOOK_MAX_ATTEMPTS`, then `failed`. Per-request timeout via `AbortController` (`WEBHOOK_TIMEOUT_MS`).
- `signPayload(secret, body)` exported for reuse/testing. `sendTestEvent()` posts a sample `message.status` payload bypassing subscription filtering (still needs a saved endpoint) and logs it like any delivery.

### Inbound capture (`src/whatsapp/inbound.ts`, `src/whatsapp/manager.ts`)
- `src/whatsapp/inbound.ts`:
  - `extractMessage(raw.message)` unwraps common envelopes (ephemeral, viewOnce, documentWithCaption) and returns type + content/caption + a media descriptor for text/image/video/audio/document; unsupported types (sticker, location, reaction, poll, …) return `null` and are ignored.
  - `isStopKeyword(text)` — whole-body match against a STOP/UNSUBSCRIBE/CANCEL/… set.
  - `handleInbound(numberId, fromPhone, raw, download)` — resolves the contact, downloads media (via the passed Baileys `downloadMediaMessage` closure) to `data/media/<uuid><ext>`, stores the inbound message, marks the contact contacted, and fires `emitInbound`. Media-download failures degrade gracefully (message still stored, `media_url` null).
- `src/whatsapp/manager.ts` — added a `messages.upsert` listener (only `type === 'notify'`; skips `fromMe`, groups `@g.us`, `status@broadcast`, and `@newsletter`). The existing outbound status listener now fires `emitMessageStatus` only when `advanceMessageStatus` returns true. Imports `downloadMediaMessage` from Baileys.
- `src/whatsapp/queue.ts` — fires `emitMessageStatus(id,'sent')` on successful send and `emitMessageStatus(id,'failed')` on final failure.

### Media download API (`src/routes/api/messages.ts`)
- `GET /api/v1/messages/:id/media` (Bearer) streams the stored media with an inferred `content-type` (extension→MIME map), confined to the media dir via `basename`. Inbound webhook payloads point here through an absolute URL.
- Payload `media_url` is built from **`config.publicBaseUrl`** (`PUBLIC_BASE_URL` env, defaults to `http://localhost:<PORT>`).

### Dashboard (`src/routes/dashboard/webhooks.ts`, `src/views/webhooks.ejs`)
- `/webhooks` (admin session): endpoint form (URL, per-event checkboxes, active toggle), secret panel (masked with reveal, regenerate, send-test), and a recent-deliveries table. `POST /webhooks`, `POST /webhooks/regenerate-secret`, `POST /webhooks/test`.
- Nav "Webhooks" is now a real link (was "soon").

### Wiring / config
- `src/server.ts` — registers `webhookDashboardRoutes` and calls `startWebhookWorker()` after listen.
- `src/config.ts` — added `publicBaseUrl`.
- `.env.example` — documented `PUBLIC_BASE_URL`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BACKOFF_MS`, `WEBHOOK_MAX_BACKOFF_MS`, `WEBHOOK_TICK_MS`.

## Decisions made during implementation (not pre-specified in the PRD)

- **Media delivery = authenticated download URL** (chosen with the user). Inbound media is saved to the volume as with outbound uploads; the payload carries an absolute `GET /api/v1/messages/:id/media` URL built from `PUBLIC_BASE_URL`. Keeps payloads small and works for any media size. (Alternatives considered: inline base64 — rejected for payload bloat; path-only — rejected as unusable by a remote receiver.)
- **Signing secret is auto-generated** (32 random bytes, hex) on first save, with reveal + regenerate in the dashboard. Zero-config and strong by default.
- **STOP is detect-and-flag only** in M4 — `is_stop` in the inbound payload — with actual consent/auto-block deferred to M5, keeping the milestone boundary clean. `contacts.consent_status`/`consent_source` remain in place for M5 to flip.
- **Signature is over the exact stored payload string.** The delivery row stores the serialized JSON once; the same bytes are signed and sent on every (re)attempt, so a receiver's recomputed HMAC always matches regardless of retries.
- **`advanceMessageStatus` now returns whether it changed**, so a `message.status` webhook fires exactly once per real transition (out-of-order/duplicate acks from Baileys don't double-fire).
- **Single non-overlapping worker with an immediate nudge.** `emit()` writes the delivery then calls the guarded `pump()`, so events go out near-instantly without a second worker racing the tick — the same pattern as the send queue.
- **Inbound status is `delivered`** (the message reached us). Groups, status broadcasts, newsletters, and our own echoes are filtered out; only 1:1 user messages are stored.
- **Graceful media-download degradation:** if Baileys can't fetch the media (expired/network), the inbound message is still stored and the webhook still fires with `media_url: null` rather than dropping the event.

## Verification (against the "Done when" criteria)

Automated verification (`scratchpad/verify-m4.mjs`, 16/16 passing) against the compiled code in an isolated data dir with a real local HTTP receiver:
- Inbound extraction for text/extendedText/image/documentWithCaption, and unsupported types ignored. ✅
- STOP keyword detection (positive + negative cases). ✅
- Secret auto-generated (≥32 chars). ✅
- `message.inbound` + `message.status` delivered to a live receiver; **HMAC signature matches the received body**. ✅
- Inbound `media_url` points to `/api/v1/messages/:id/media`; `from` and `is_stop` populated. ✅
- **Retry works:** a forced HTTP 500 on the first attempt is retried with backoff and then logged `success` (attempts ≥ 2). ✅
- Deliveries recorded in the log with status/attempts. ✅

App-level: host boot is clean, `/api/v1/messages/{id}/media` appears in `/openapi.json`, `/webhooks` redirects unauthenticated users to login, both workers start. The Docker container was rebuilt (`docker compose up -d --build`, data preserved) and the real linked number (`test`, `15513423891`) reconnected as `linked` on M4 code.

**Live WhatsApp round-trip — CONFIRMED.** With the running Docker container's webhook endpoint pointed at a local receiver (via `host.docker.internal`), a real phone (`919663291144`) sent to the linked number (`15513423891`):
- An **image with caption** → one signed `message.inbound` (`from: 919663291144`, `type: image`), and its media downloaded through `GET /api/v1/messages/:id/media` as a valid 1280×590 JPEG (HTTP 200, `image/jpeg`, 55,848 bytes). ✅
- A **`Stop`** text → one signed `message.inbound` with `is_stop: true` (case-insensitive). ✅
- HMAC signature verified against the received body. ✅

### Bugs found by the live test and fixed
The first live send exposed three defects the automated suite (no real socket) couldn't:
1. **Duplicate inbound** — Baileys emits `messages.upsert` more than once for the same message, so it was stored (and webhooked) twice. Fixed by deduping on `provider_message_id` in `handleInbound` (skip if a message with that id already exists).
2. **Sender was a LID, not a phone** — WhatsApp addressed the 1:1 chat by `<id>@lid`, so `from` was the opaque LID `176845312012504`. Fixed by resolving the phone-number JID from `key.remoteJidAlt` (Baileys 7 carries the `@s.whatsapp.net` alt) when `remoteJid` is a LID.
3. **Inbound message fired a bogus `message.status`** — the outbound status listener matched the inbound row by provider id. Fixed by guarding the listener to `direction === 'outbound'`.

A regression test for the dedupe path was added to `verify-m4.mjs` (now **17/17**). All three fixes were re-confirmed by the live re-test above.

## Anything the next milestone (5 — Health & Consent) needs to know

- **Consent hook is ready.** Inbound STOP is already detected (`isStopKeyword` in `src/whatsapp/inbound.ts`) and surfaced as `is_stop` in the payload. M5 should, on inbound STOP, set `contacts.consent_status='blocked'` + `consent_source` (the columns exist), and reject outbound sends to blocked contacts in `enqueueMessage`/the queue.
- **Health events can reuse the webhook dispatcher.** Add a `health.*` event type to `WEBHOOK_EVENTS` and a `emitHealth(...)` helper mirroring `emitMessageStatus`; the worker/signing/retry/log all work unchanged. The dashboard checkbox list is driven by `WEBHOOK_EVENTS`, so a new event type shows up automatically.
- **Status transitions** already flow through `emitMessageStatus` (queue for sent/failed; manager for delivered/read). Any risk signals M5 derives from delivery drops can read the `messages` status history.
- **Media convention** for inbound mirrors outbound: `data/media/<uuid><ext>`, `media_path` internal, exposed only via the Bearer-auth download route.

## Deviations from the PRD

- None functional. Single webhook endpoint (as the PRD scopes for v1); no message-history pull API (webhook-push only, as specified); STOP detection present but enforcement deferred to M5 (as specified). Media is exposed via an authenticated URL rather than an opaque "reference" — this satisfies "a reference the webhook payload points to" while remaining fetchable by a remote receiver.

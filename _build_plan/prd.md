# WaGuard — Self-Hosted WhatsApp API

> **About these build-plan files:** Everything in `_build_plan/` (this PRD and the per-milestone folders) is a **temporary documentation and guidance artifact** for the initial build-out of this codebase. These files are not functional — no code, configuration, runtime logic, tests, or deployment process should import, read, reference, or depend on anything in `_build_plan/`. Once the initial milestones are built and shipped, the entire `_build_plan/` folder is expected to be deleted from the codebase. Do not treat it as long-living documentation.

## What we're building

WaGuard is a self-hosted WhatsApp automation service that links to your own existing WhatsApp number by scanning a QR code — the same way WhatsApp Web works — and exposes a simple API to send and receive messages, running entirely on your own infrastructure with no dependency on Meta's Cloud API, no Business-account requirement, and no third-party provider.

The single most important design goal is keeping the number safe. Every part of the system is built to drive the flagging risk as close to zero as possible through human-like behavior, and a built-in health/feedback mechanism monitors account status, warns of danger signs early, and — if a number ever does get flagged — captures the signals around that event so the behavior model can be improved over time.

WaGuard is intentionally a **pure, headless API service**. It knows nothing about CRMs, pipelines, or campaigns. Its only job is to be a rock-solid, well-documented WhatsApp API that any downstream app — a WhatsApp CRM such as `wacrm`, or your own tools — can plug into. The self-serve API documentation page is a first-class feature so downstream systems can read the contract and build against it.

It is built with **Node.js + TypeScript**, using the **Baileys** library to talk WhatsApp's multi-device protocol directly over a WebSocket (no headless browser, so it stays fast and lightweight), **Fastify** for the API (which auto-generates the OpenAPI/Swagger docs), and **SQLite** for storage. The recommended way to run the entire service is as a **single Docker container** — for ease, the only thing that needs to be installed on the host is Docker itself; no Node.js, no build tools, and no other runtime dependencies. Data (the SQLite database, stored sessions, and media files) persists on a mounted volume so it survives container restarts and rebuilds. Running the service directly on a host (with Node.js installed) is also supported as a fallback; Docker is preferred purely for convenience, not as a hard requirement. The build is structured around 5 milestones, each delivering something runnable and testable.

> **Reality note on bans:** This approach uses the unofficial WhatsApp Web protocol, which is against WhatsApp's Terms of Service. There is no cap or waitlist (that is the official API's world), but there is inherent ban *risk*. WaGuard is designed to minimize that risk as far as technically possible — it cannot eliminate it, and it cannot obtain the exact reason WhatsApp bans a number (WhatsApp never discloses it). The health monitor captures the best available signals instead.

---

### What the app does

- Links one or more of your existing WhatsApp numbers by scanning a QR code, and keeps each session alive with automatic reconnect.
- Exposes a simple, token-secured API any app can call to send text, image, document, audio, and video messages.
- Routes every outbound message through an anti-ban queue that paces sends to mimic a real human, with per-number limits, warm-up, and quiet hours.
- Captures incoming messages and delivery/read status and pushes them to your own systems via signed webhooks.
- Continuously monitors each number's health, warns of danger signs early, and logs a diagnostic timeline around any flagging event.
- Enforces consent guardrails so blocked or non-consented recipients are never messaged, reducing the top ban trigger.
- Provides a minimal admin dashboard to link numbers, manage tokens and webhooks, and inspect health, queue, and logs.
- Publishes a live, always-accurate API documentation page (with a downloadable OpenAPI spec) that downstream systems can read and build against.

---

### Already provided by the existing codebase

This is a fresh, empty project — there is no starter template. Everything is built from scratch during the milestones below. The chosen stack (Node.js + TypeScript, Baileys, Fastify, SQLite) is intentionally lean so the service stays fast, responsive, and lightweight, and can run as a single small service on a cheap VPS. The service is packaged as a **single Docker container** as the recommended way to run it — a user brings up the whole thing with one command (e.g. `docker compose up`) with only Docker on the host, and all persistent data lives on a mounted volume. Running directly on a host with Node.js is also supported as a fallback; Docker is preferred for ease, not required.

---

### Out of scope

- **Group messaging** — group sends follow different rules and ban dynamics; deferred to v2.
- **Bulk / broadcast campaigns** — the highest ban-risk feature; deserves its own careful design in v2.
- **Template / message library** — saved reusable messages; v2.
- **Contact import** — CSV/address-book import; v2.
- **Auto-reply / chatbot / AI responses** — WaGuard sends and receives; the downstream app decides replies.
- **Multi-user / team accounts & roles** — single admin owner in v1, no per-seat permissions.
- **Billing / subscriptions / usage metering** — it's your own self-hosted service; no payment layer.
- **Analytics & reporting dashboards** — health monitoring stays, but no campaign analytics or charts.
- **Mobile app / browser extension** — API plus a minimal web dashboard only.
- **Cloud-hosted multi-tenant SaaS** — v1 is single-tenant, self-hosted for your own numbers.
- **Machine-learning / adaptive auto-tuning of anti-ban parameters** — v1 is rule-based and logs evidence for you to learn from; auto-tuning is later.
- **Proxy / IP rotation** — not in v1.

---

### Data model

#### WhatsApp Number (Session)

- **label** — a friendly name you give this number.
- **phone number** — the number itself.
- **connection status** — linked, connecting, disconnected, or flagged.
- **session credentials** — the stored (encrypted) login data that keeps the number connected without re-scanning.
- **warm-up stage** — where this number is in its gradual ramp-up.
- **daily send count & date** — how many messages went out today, and which day that counts for.
- **created / linked date** — when the number was added and last linked.

#### API Client / Token

- **name** — a label for the downstream app this token belongs to.
- **token** — the secret value the app presents on every call.
- **scopes / permissions** — what this token is allowed to do.
- **active status** — whether the token is currently valid or revoked.
- **last-used time** — when it last made a call.

#### Contact / Recipient

- **phone number** — the recipient's number.
- **display name** — optional friendly name.
- **consent status** — opted-in, unknown, or blocked.
- **consent source** — where the consent (or block) came from.
- **first / last contacted** — timestamps of the relationship.

#### Message

- **direction** — outbound or inbound.
- **number** — which linked Number it belongs to.
- **recipient** — which Contact it's to/from.
- **type** — text, image, document, audio, or video.
- **content / caption** — the text or media caption.
- **media file reference** — pointer to the stored media file, if any.
- **status** — queued, sent, delivered, read, or failed.
- **timestamps** — when it was created, sent, and updated.
- **provider message id** — WhatsApp's own id for the message.
- **failure reason** — why it failed, if it did.

#### Queued Job

- **message** — the Message this job will send.
- **scheduled-send time** — when it's allowed to go out.
- **attempt count** — how many times sending has been tried.
- **state** — waiting, processing, done, or failed.
- **applied delay** — the human-like delay chosen for this send.

#### Webhook Endpoint

- **target URL** — where events get pushed.
- **event types** — which events this endpoint subscribes to.
- **secret** — used to sign payloads so the receiver can verify them.
- **active status** — whether it's currently receiving.

#### Health Event

- **number** — which Number the event concerns.
- **event type** — disconnect, block-signal, delivery-drop, flagged, or warm-up-change.
- **severity** — how serious it is.
- **activity snapshot** — recent send rate, volume, and timing captured around the event.
- **notes** — human-readable description.
- **timestamp** — when it happened.

**Relationships:** Each WhatsApp Number has many Messages, Queued Jobs, and Health Events. Each Message belongs to one Number and one Contact. Each Queued Job wraps one Message. API Tokens and Webhook Endpoints are app-wide (single-tenant owner).

---

## Milestone 1 — Foundation & Access

Stands up the running service, storage, admin login, API-token authentication, and the live (initially empty) auto-generated API documentation page.

### What gets built

- A running Fastify service backed by SQLite, packaged as a **single Docker container** (the recommended way to run it) that starts with one command (e.g. `docker compose up`) with only Docker on the host, and all data (database, sessions, media) persisted on a mounted volume that survives restarts and rebuilds. A direct, non-Docker run on a host with Node.js is also supported as a fallback.
- An admin login for the dashboard (single owner account, password-protected).
- The ability to create, name, and revoke API tokens from the dashboard.
- Token-based API authentication: any API call without a valid token is rejected.
- A live API documentation page served by the app, auto-generated from the API itself, plus a downloadable OpenAPI spec file (endpoints appear here as later milestones add them).
- A dashboard shell with navigation for the pages later milestones fill in.

### What milestone 1 explicitly does NOT include

- Any WhatsApp connection or QR linking (milestone 2).
- Sending or receiving messages.
- The anti-ban engine, queue, health monitor, or consent logic.
- Multiple admin users or roles.

### Done when

You can bring the whole service up with a single Docker command on a host that has only Docker installed (with the non-Docker run also working as a fallback), log into the dashboard, create and revoke an API token, be rejected when calling the API without a valid token, open the live API docs page and download the OpenAPI spec, and confirm your data survives a container restart.

---

## Milestone 2 — Link a Number

Adds the WhatsApp connection: scan a QR code to link a number, keep it connected, and see its live status.

### What gets built

- A dashboard page that displays a QR code to scan from WhatsApp → Linked Devices.
- Support for linking multiple numbers, each shown with a live status badge (linked / connecting / disconnected / flagged).
- Automatic reconnect if a connection drops, without re-scanning (as long as the session is still valid).
- A clear prompt to re-scan only when WhatsApp has actually invalidated the session.
- An unlink / log-out action per number from the dashboard.
- A read-only API endpoint to check a number's connection status.

### What milestone 2 explicitly does NOT include

- Sending or receiving messages (milestones 3 and 4).
- Pairing via phone-number code instead of QR (v2).
- Automatic failover to a backup number.

### Done when

You can scan the QR code with your phone, see your number go to "linked", restart the service and have it reconnect without re-scanning, and unlink the number from the dashboard.

---

## Milestone 3 — Safe Sending

Delivers the core value: a send API whose messages flow through the anti-ban queue and pacing engine so they go out like a real person sent them.

### What gets built

- A send-message API endpoint: specify the sending number, recipient, message type (text, image, document, audio, video), and content/caption; media may be a URL the service fetches or an uploaded file.
- Every send returns a message id and a trackable status (queued → sent → delivered → read / failed).
- All outbound messages pass through a queue that enforces pacing before releasing them; the API responds immediately with "queued".
- The anti-ban engine: randomized human-like delays, typing/"online" simulation before sending, per-number daily send limits with safe defaults, warm-up ramp for new/idle numbers, burst/rate throttling, and configurable quiet hours.
- Scheduled sends: request a message to go out at a specific future time.
- Queue visibility in the dashboard (waiting / processing / failed per number) with automatic retry of failed sends and recorded failure reasons.
- Manual pause/resume of a number's queue from the dashboard; the queue survives a service restart.
- Basic recipient-number validation before queuing.

### What milestone 3 explicitly does NOT include

- Receiving messages or webhooks (milestone 4).
- Health monitoring and consent guardrails (milestone 5).
- Sending to multiple recipients at once, groups, or broadcasts (v2).
- Interactive messages (buttons, lists), locations, polls, reactions, or editing/deleting sent messages.

### Done when

You can call the send API for text and media, watch the message pass through the queue with a human-like delay and typing indicator, see its status update to delivered/read, schedule a future send, and pause/resume a number's queue.

---

## Milestone 4 — Receiving & Webhooks

Closes the loop: incoming messages and status updates are captured, stored, and pushed to your downstream systems.

### What gets built

- Incoming messages to any linked number are captured and stored.
- A webhook configuration page: set the endpoint URL, choose which event types to receive, and see recent deliveries.
- Webhook events for incoming messages and for outbound status updates (sent / delivered / read / failed).
- Incoming media is downloaded and stored, with a reference the webhook payload points to.
- Webhook payloads are signed with a secret so the receiver can verify authenticity.
- Automatic retry of webhook delivery if the endpoint is temporarily down, so events aren't silently lost.
- The "STOP"-style inbound keyword is detected here and passed along for the consent handling built in milestone 5.

### What milestone 4 explicitly does NOT include

- The health monitor and consent enforcement (milestone 5).
- Multiple webhook endpoints or per-event routing (single endpoint in v1).
- A pull/polling API to fetch message history (webhook-push only in v1; messages are still stored).

### Done when

You can configure a webhook URL, send a message to your linked number from another phone, and see a signed webhook fire to your endpoint with the message (and any media reference), plus status-update webhooks for your outbound messages.

---

## Milestone 5 — Health & Consent

Completes the anti-ban story: continuous health monitoring with a diagnostic feedback log, consent guardrails, and final docs polish.

### What gets built

- Live health status per number in the dashboard (healthy / at-risk / flagged).
- Danger-sign detection: unexpected disconnects, repeated re-login prompts, spikes in failed/undelivered messages, and abnormal send-failure patterns.
- Early warnings surfaced in the dashboard and fired to the webhook when a number trends toward risk.
- A Health Event log storing each notable event with a snapshot of surrounding activity (recent send rate, volume, timing) and a post-flag timeline so you can learn what led up to it.
- Auto cool-down: when a number is at-risk, the anti-ban engine slows or pauses it automatically.
- Consent guardrails: each contact has a consent status (opted-in / unknown / blocked); sends to blocked numbers are rejected, and unknown-number sends follow a configurable policy.
- API to mark a contact opted-in/blocked with a recorded consent source, plus auto-block on inbound "STOP"-style keywords.
- A searchable contacts list in the dashboard, and invalid/non-WhatsApp numbers rejected before wasting a send.
- Final API-docs polish: "try it" capability on the docs page using a token, and the complete downloadable OpenAPI spec covering all endpoints and webhook payloads.

### What milestone 5 explicitly does NOT include

- Predictive ML risk scoring or automatic parameter auto-tuning (v1 is rule-based; it logs evidence for you).
- Automatic remediation beyond cool-down (e.g., auto-appealing a ban).
- Full opt-in web forms, double opt-in, consent expiry, or consent-list import (v2).
- Per-number (rather than global) consent policies.

### Done when

You can see each number's live health status, trigger and view a health event with its activity snapshot, watch an at-risk number auto-cool-down, have a send to a blocked contact rejected, auto-block a contact via an inbound "STOP", and use the "try it" feature on the finished API docs page.

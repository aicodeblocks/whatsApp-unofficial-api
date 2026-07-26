# WaGuard v2 — Dashboard, Developer Portal & Scale

> **About these build-plan files:** Everything in `_build_plan/` (this PRD and the per-milestone folders) is a **temporary documentation and guidance artifact** for the build-out of this codebase. These files are not functional — no code, configuration, runtime logic, tests, or deployment process should import, read, reference, or depend on anything in `_build_plan/`. Once the milestones are built and shipped, the `_build_plan/` folder is expected to be deleted. (This `v2/` sub-folder is the second build phase; the original v1 plan lives one level up in `_build_plan/`.)

## What we're building

**WaGuard v2** turns the working v1 service into a polished, professional product surface. It gives the admin dashboard a redesigned visual shell — a branded header and footer, a consistent design system, and an at-a-glance "implementation status" overview that shows everything the service now does. On top of that it adds a first-class **developer portal**: downstream teams can read the full API contract in a clean, human-friendly layout *and* call the live API directly from the panel with a token, so they can try it and start consuming the service without any separate tooling.

v2 also lands the functional features deliberately deferred from v1 — **contact import, a template library, interactive buttons, bulk/broadcast campaigns, group messaging, and an analytics/reporting dashboard** — all routed through the existing anti-ban pacing, health, and consent safeguards.

It is built on the **same stack as v1**: Node.js + TypeScript · Fastify 5 (auto-OpenAPI) · better-sqlite3 · EJS server-rendered dashboard · Baileys 7 · a single Docker container with data on a mounted volume. The build is structured around 5 milestones, each delivering something runnable and testable in the browser.

---

### What the app does (new in v2)

- Presents a redesigned, professional dashboard with a branded header, footer, consistent design system, and light/dark theme.
- Shows an at-a-glance Overview home with a live status card for every implemented capability plus a system-health strip and recent-activity feed.
- Publishes a human-friendly API documentation portal for downstream teams: getting-started, endpoints, auth, and webhook payloads.
- Lets downstream users call the live API straight from an interactive console panel using a token and see real responses.
- Imports recipients from a CSV file into named contact lists, with validation and consent.
- Saves reusable message templates with fill-in placeholders, optional media, and buttons.
- Attaches interactive buttons (quick-reply, call, link) to messages, templates, and broadcasts.
- Runs bulk/broadcast campaigns to a list, paced by the anti-ban engine, with live progress and pause/resume.
- Sends messages to WhatsApp groups a linked number belongs to.
- Provides an analytics & reporting dashboard with date-range charts, KPI tiles, and CSV export.

---

### Already provided by the existing codebase (v1 — do not re-spec)

- A running Fastify + SQLite service packaged as a single Docker container, data on a mounted volume.
- Admin login + session-cookie auth; API-token creation/revocation; token-based API auth.
- Auto-generated OpenAPI docs at `/docs` and a downloadable spec at `/openapi.json`.
- QR number linking with automatic reconnect; per-number live status; unlink.
- The send API and the anti-ban send **queue + pacing engine** (randomized delays, typing simulation, per-number daily limits, warm-up ramp, quiet hours, scheduled sends, pause/resume).
- Inbound message capture and media download.
- Signed **webhooks** (`message.inbound`, `message.status`, `health.event`) with retry + a delivery log, and a Webhooks configuration page.
- **Health monitoring** (healthy / at-risk / flagged), danger-sign detection, auto cool-down, and escalating cool-off.
- **Consent guardrails**: per-contact consent status, blocked-recipient rejection, auto-block on inbound STOP, and a searchable Contacts page + consent API.
- The existing EJS dashboard shell and pages (Overview, Numbers, Send & Queue, Contacts, Webhooks, Health, API Tokens) — v2 restyles and extends these, it does not rebuild them from scratch.

---

### Out of scope (v2) — logged as the v3 backlog for later

- **Auto-reply / chatbot / AI responses** — WaGuard sends and receives; reply logic stays in the downstream app.
- **Multi-user / team accounts & roles** — v2 remains single-admin owner; no per-seat permissions.
- **Adaptive / ML anti-ban auto-tuning** — v2 stays rule-based; it logs evidence for you to learn from.
- **Proxy / IP rotation** — network-level anti-ban is not in v2.
- **Phone-number code pairing** — QR linking only; pairing-by-code is deferred.
- **Richer consent lifecycle** — opt-in web forms, double opt-in, consent expiry/import, and per-number (rather than global) consent policies.
- **Live address-book sync** — contact import is CSV-only in v2; Google Contacts / address-book sync (and its integration + credentials) is deferred.
- **Other interactive message types** — lists, polls, locations, reactions, product/catalog messages, flows, and editing/deleting sent messages (v2 covers buttons only).
- **Multi-number round-robin splitting, drip sequences, send-time optimization** for broadcasts.
- **Group administration** — creating groups, adding/removing participants, admin actions (v2 only *sends* to existing groups).
- **Real-time streaming dashboards, a custom report builder, and scheduled email reports** for analytics.
- **Mobile app / browser extension · billing & subscriptions · cloud-hosted multi-tenant SaaS** — platform and business-model expansion.

---

### Data model

v2 keeps every v1 entity (WhatsApp Number, API Token, Contact, Message, Queued Job, Webhook Endpoint, Webhook Delivery, Health Event) and adds the following. Fields are described in plain language — what the app needs to remember, not database types.

#### Message Template
- **name** — a friendly label for the template.
- **category** — an optional grouping (e.g. "welcome", "promo").
- **body** — the message text, with fill-in placeholders like `{{name}}`.
- **media reference** — an optional attached image/document/etc.
- **buttons** — an optional set of interactive buttons (see below).
- **created / updated** — timestamps.

#### Interactive Button
- **type** — quick-reply, call, or link.
- **label** — the text shown on the button.
- **payload** — for call, the phone number to dial; for link, the web address to open; for quick-reply, the reply value.
- **belongs to** — the template or message it is attached to (a message/template can carry a few).

#### Contact List (segment)
- **name** — a friendly name for the segment.
- **description** — optional note.
- **members** — the contacts that belong to it (a contact can be in many lists).
- **created** — timestamp.

#### Contact Import
- **file name** — the uploaded CSV's name.
- **counts** — how many rows were imported / skipped / invalid.
- **target list** — the list the contacts were added to.
- **status** — pending, completed, or failed.
- **created** — timestamp.

#### Broadcast Campaign
- **name** — a friendly campaign name.
- **content** — a chosen template, or inline body + optional media + buttons.
- **target** — the contact list (or filter) to send to.
- **sending number** — which linked number sends it.
- **schedule** — optional future start time.
- **pacing settings** — the anti-ban pacing this campaign uses.
- **progress counts** — queued / sent / delivered / read / failed / skipped.
- **status** — draft, scheduled, sending, paused, completed, or cancelled.
- **created / updated** — timestamps.

#### Group
- **provider group id** — WhatsApp's own id for the group.
- **name / subject** — the group's display name.
- **linked number** — which of your numbers belongs to it.
- **participant count** — how many members it has.
- **last synced** — when the group list was last refreshed.

#### Daily Stats (rollup)
- **number** — which linked number the tally is for.
- **date** — the day.
- **counts** — sent / delivered / read / failed / received for that day.

**Relationships:** A Message Template has many Interactive Buttons and can be used by many Broadcast Campaigns and Messages. A Contact belongs to many Contact Lists; a Contact List has many Contacts. A Contact Import populates one Contact List. A Broadcast Campaign targets one Contact List, sends from one Number, and produces many Messages. A Group belongs to one Number. Daily Stats roll up Messages per Number per day. Existing **Message** gains optional links to the Template and Campaign it came from and can carry Interactive Buttons.

---

## Milestone 1 — Design system & dashboard shell + status overview

Establishes the professional visual foundation — a branded, consistent shell every page renders inside — and a live Overview home that shows the state of everything already built.

### What gets built

- A cohesive design system applied across the dashboard: typography, light/dark color tokens, spacing, and reusable cards, badges, buttons, tables, and page headers, so every page looks like one product.
- A branded app shell: a header with the WaGuard logo/name, an environment/connection indicator (e.g. how many numbers are linked), and an account menu with logout; a footer showing the app version/build and links to the API Docs, Health, and status.
- A refined icon left-navigation covering every area (Overview, Numbers, Send & Queue, Contacts, Templates, Broadcasts, Webhooks, Health, Analytics, API Docs).
- A persistent light/dark theme toggle.
- A responsive layout that holds up down to tablet width.
- An **Overview home page**: a card per capability area (Numbers, Send & Queue, Receiving, Webhooks, Health, Contacts) showing live counts and a status dot (active / idle / needs-attention); a system-health strip (numbers linked, queue depth, at-risk numbers, webhook delivery health); quick actions; and a recent-activity feed.

### What milestone 1 explicitly does NOT include

- The API documentation portal or interactive console (milestone 2).
- Any new functional features — import, templates, buttons, broadcasts, groups, analytics charts (later milestones).
- White-label theming, user-customizable/drag-drop dashboard widgets, or a phone-first redesign.

### Done when

You can open the dashboard and see the new branded header and footer with a consistent design on every existing page, toggle light/dark, and the Overview home shows accurate live status cards, a system-health strip, and recent activity for every capability already implemented.

---

## Milestone 2 — Developer portal: docs + interactive API console

Gives downstream teams a first-class way to understand and consume the API: a readable contract plus a live "try it" console — all inside the branded panel.

### What gets built

- A human-friendly **API documentation portal** (distinct from the raw Swagger UI), grouping endpoints by area (Numbers, Messages, Contacts, Health, Webhooks) with: a downstream getting-started section (create a token, the base URL, a first call), each endpoint's purpose, parameters, and example request + response, an explanation of the webhook payloads and signature verification, copy-paste curl snippets, search/filter, and a link to download the OpenAPI spec.
- An **interactive API console** in the portal: pick an endpoint, fill a parameter form, supply a token (remembered for the session), press Send, and see the real live response (status and body) formatted for reading. Covers the main endpoints downstream systems need.

### What milestone 2 explicitly does NOT include

- Client SDKs or code generation, versioned documentation history, or a changelog engine.
- Saved request collections or environment management in the console.
- Any new functional features (later milestones).

### Done when

A downstream user can open the docs portal, read the contract and getting-started, paste an API token, call a live endpoint from the console, and see the real response — without leaving the panel or using a separate tool.

---

## Milestone 3 — Contacts & content: import + lists + templates + buttons

Builds the content and audience foundation that broadcasts will stand on: importable contact lists, reusable templates, and interactive buttons.

### What gets built

- **CSV contact import**: upload a CSV, map columns (phone, name, consent), see a validation preview with invalid and duplicate rows flagged, choose or create a target list, confirm, and see a result summary; imported contacts appear in the Contacts page.
- **Contact lists / segments**: create named lists, add/remove contacts, and filter the Contacts page by list and consent status.
- **Template library**: create, edit, and delete named templates with body text containing `{{placeholders}}`, an optional media attachment, and a live preview; pick a template when sending a message.
- **Interactive buttons**: attach quick-reply, call, and link buttons to templates and to the single-send form; placeholder values are filled from contact fields when the message is built.

### What milestone 3 explicitly does NOT include

- Broadcast campaigns or group messaging (milestone 4) and analytics (milestone 5).
- Live address-book sync, scheduled/automatic imports, or advanced de-duplication/merge beyond skipping.
- Template approval workflows, versioning, shared/team libraries, or A/B variants.
- Interactive message types beyond buttons (lists, polls, etc.).

### Done when

You can import a CSV into a named list, create a template with placeholders and buttons, and send a single templated message with buttons that the recipient actually receives.

---

## Milestone 4 — Sending at scale: broadcasts + group messaging

Delivers the highest-value (and highest-risk) capability: bulk sends to a list under full anti-ban control, plus sending to existing WhatsApp groups.

### What gets built

- **Broadcast campaigns**: create a campaign (name, choose a template or write inline content, pick a target list or filter, choose the sending number, optionally schedule a start), see an estimated send window under the anti-ban pacing, and launch it; watch live progress (queued / sent / delivered / read / failed); pause, resume, or cancel; blocked and non-consented recipients are automatically skipped; per-number daily limits and health cool-off are respected.
- **Group messaging**: sync the WhatsApp groups a linked number belongs to, list them, and send a text, media, or templated message to a chosen group through the paced queue; inbound group messages are captured (flagged as group) and pushed via webhook.

### What milestone 4 explicitly does NOT include

- The analytics/reporting dashboards (milestone 5).
- Splitting a broadcast across multiple numbers, drip sequences, or per-recipient send-time optimization.
- Creating or administering groups, or adding/removing participants (v2 only sends to existing groups).
- Interactive list/poll messages.

### Done when

You can launch a broadcast to an imported list and watch it progress live under anti-ban pacing (pausing and resuming it), and you can pick a synced WhatsApp group and send a message to it.

---

## Milestone 5 — Analytics & reporting

Closes v2 with the reporting layer: date-range charts and KPIs across numbers and campaigns, plus export.

### What gets built

- An **Analytics page** with date-range charts: sends over time, delivered / read / failed rates, inbound volume, a per-number breakdown, campaign performance, and health incidents over time.
- Summary **KPI tiles** for the selected range (e.g. total sent, delivery rate, read rate, failures, inbound).
- **CSV export** of the selected range.
- A **daily-stats rollup** that keeps the charts fast without recomputing all history.

### What milestone 5 explicitly does NOT include

- Real-time streaming dashboards, a custom/ad-hoc report builder, or scheduled email reports.
- Predictive or ML-driven insights (v2 stays descriptive).

### Done when

You can open Analytics, pick a date range, and see accurate charts and KPI tiles spanning numbers and campaigns, then export that range to CSV.

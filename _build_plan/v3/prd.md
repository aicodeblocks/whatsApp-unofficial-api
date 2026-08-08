# WaGuard v3 — Auto-Reply Bot, AI Fallback & Turnkey Deploy

> **About these build-plan files:** Everything in `_build_plan/` (this PRD and the per-milestone folders) is a **temporary documentation and guidance artifact** for the build-out of this codebase. These files are not functional — no code, configuration, runtime logic, tests, or deployment process should import, read, reference, or depend on anything in `_build_plan/`. Once the milestones are built and shipped, the entire `_build_plan/` folder is expected to be deleted. Do not treat it as long-living documentation. (This `v3/` sub-folder is the third build phase; v1 lives at the `_build_plan/` root and v2 in `_build_plan/v2/`.)

## What we're building

**WaGuard v3** adds the one capability explicitly deferred to the v3 backlog in v2: an **auto-reply bot**. The bot is **template-driven at its core** — an admin creates a bot, assigns it reusable v2 message templates, and defines trigger→template rules (a "template flow": e.g. *"reply HELP for menu"* → menu template → menu selections → item templates, with a default-case template for anything off-menu). WaGuard itself watches inbound messages, matches the rule, and auto-sends the reply through the existing anti-ban, health, and consent engine.

On top of that template backbone sits an **AI toggle that is the paid upgrade**. With **AI off**, the bot is a pure template menu — a client who isn't ready to pay still gets a working auto-responder, and off-menu input hits the default-case template. With **AI on**, anything the templates and rules *don't* cover — a free-form question like *"do you deliver on Sundays?"* — is answered by an AI reply grounded in an admin-defined persona and knowledge base, then the bot can gently re-show the menu. The template flow is always the backbone; AI only ever intercepts the off-script moment that would otherwise fall to the default-case template.

The AI layer is **provider-pluggable** behind a single interface (adapted from the user's `opentemplatesms` `AIProviderInterface` design): **Claude is the recommended default**, with OpenAI as an alternative/fallback and Ollama for self-hosted / cloud-free / air-gapped deployments. Every piece — bots, rules, templates, knowledge base, AI config — is also exposed through a **bot management API** documented in the existing developer portal, so downstream apps can consume or fully control the bot. v3 also makes **Cloudways deployment turnkey**, so a Git deploy needs little or no manual server configuration.

It is built on the **same stack as v1/v2**: Node.js + TypeScript (ESM/NodeNext) · Fastify 5 (auto-OpenAPI) · better-sqlite3 · EJS server-rendered dashboard · Baileys 7 · a single Docker container with data on a mounted volume (and PM2 + Apache `.htaccess` on Cloudways). The build is structured around 6 milestones, each delivering something runnable and testable in the browser.

---

### Cross-cutting requirement: API-first & self-documenting (applies to every milestone)

Every user-facing capability in v3 ships with a **token-authed REST API** alongside its dashboard UI, in the **same milestone** that introduces the feature — not deferred to a single "API milestone." Each new endpoint is automatically part of the **OpenAPI spec** (`/openapi.json`), rendered in `/docs`, and surfaced in the human-friendly `/developers` portal with the **same level of detail as the existing v1/v2 API docs**: what the endpoint does, its auth, request/response payload examples, and a runnable entry in the interactive console. A downstream app must be able to discover *what to call and how to call it* entirely from the published docs, with no out-of-band explanation from the maintainer. Milestone 4 does not "add the API" — it completes the developer experience (the preview/trigger-reply endpoint, portal getting-started copy, and end-to-end examples) on top of the per-feature APIs the earlier milestones already shipped.

---

### What the app does (new in v3)

- Lets the admin create **bots** and bind each bot to one or more linked WhatsApp numbers (one active bot per number).
- Assigns reusable v2 **templates** as a bot's replies and defines **trigger→template rules** (keyword / contains / exact / regex, with priority order) to build a template menu flow.
- Auto-answers inbound WhatsApp messages in real time, routed through the existing **anti-ban / health / consent** engine (respects quiet hours, daily limits, blocked contacts), with a global and per-bot kill switch.
- Uses a **default-case template** for off-menu input when AI is off — the bot never leaves a sender hanging.
- Offers a per-bot **AI toggle** (the paid upgrade): when on, off-script input is answered by an AI reply grounded in an admin-defined **persona + knowledge base**, then the menu can be re-shown.
- Provides an **AI Provider Hub** to connect Claude / OpenAI / Ollama, test the connection, set per-task model routing, and cap monthly token/cost spend.
- Lets the admin build each bot's **knowledge base** by pasting text or uploading documents, which become semantically searchable for the AI fallback.
- Exposes a full **bot management API** (bots, rules, templates, KB, AI config, plus a preview/trigger-reply endpoint) documented in the `/developers` portal with an interactive console.
- Shows a **conversation log & bot analytics** view: per-thread history of what came in and whether a rule or AI answered, plus KPIs (auto-resolution rate, rule-vs-AI share, token spend, deflection) with CSV export.
- Ships a **turnkey Cloudways deploy** so a Git deploy requires little or no manual server work.

---

### Already provided by the existing codebase (v1 + v2 — do not re-spec)

- A running Fastify + SQLite service packaged as a single Docker container, data on a mounted volume; PM2 + Apache `.htaccess` reverse-proxy deploy on Cloudways.
- Admin login + session-cookie auth; API-token creation/revocation; token-based API auth.
- Auto-generated OpenAPI docs at `/docs`, a downloadable spec at `/openapi.json`, and the human-friendly `/developers` portal with an interactive API console.
- QR number linking with automatic reconnect; per-number live status; unlink.
- The send API and the anti-ban send **queue + pacing engine** (randomized delays, typing simulation, per-number daily limits, warm-up ramp, quiet hours, scheduled sends, pause/resume).
- **Inbound message capture** and media download.
- Signed **webhooks** (`message.inbound`, `message.status`, `health.event`) with retry + a delivery log, and a Webhooks configuration page.
- **Health monitoring** (healthy / at-risk / flagged), danger-sign detection, auto cool-down, and escalating cool-off.
- **Consent guardrails**: per-contact consent status, blocked-recipient rejection, auto-block on inbound STOP, and a Contacts page + consent API.
- The **template library** with `{{placeholders}}`, optional media, and interactive buttons (rendered as a numbered text-list fallback — native WhatsApp buttons are silently undeliverable for personal numbers).
- Contact import + contact lists/segments, broadcast campaigns, group messaging, and the analytics/reporting dashboard.
- The branded EJS dashboard shell, design system, light/dark theme, and Overview home — v3 restyles/extends these, it does not rebuild them.

---

### Out of scope (v3) — logged as the v4 backlog for later

- **Multi-step / stateful conversation flows** — v3 is stateless keyword routing (each inbound keyword maps to a template); the bot does not remember where a sender is in a multi-turn flow. A booking-style state machine is v4.
- **Human handoff / live-agent inbox** — v3 does not route a thread to a person or provide a takeover inbox (the existing webhook can notify an external system, but no in-app handoff UI is built).
- **AI copywriter** — generating/optimizing outbound campaign copy is a separate v4 add-on.
- **Pre-send AI compliance / spam check** — flagging risky wording before a send is v4.
- **AI translation / localization** — auto-detecting and replying in the sender's language is v4.
- **Smart send-time optimization** — predicting the best send window is v4.
- **Multi-tenant / per-seat bot configuration & roles** — v3 remains single-admin owner; no per-client accounts or permissions.
- **Voice / calls** — text messaging only.
- **Numbered-button reply parsing as a distinct engine** — the bot routes on inbound text via rules; it does not implement a separate parser for the text-fallback button numbers beyond ordinary keyword rules.

---

### Data model

v3 keeps every v1/v2 entity (WhatsApp Number, API Token, Contact, Message, Queued Job, Webhook Endpoint, Webhook Delivery, Health Event, Message Template, Interactive Button, Contact List, Campaign, Group, etc.) and adds the following. Fields are described in plain language — what the app needs to remember, not database types.

#### Bot
- **name** — a friendly label for the bot (e.g. "Sales bot", "Support bot").
- **number scope** — which linked WhatsApp number(s) this bot answers for. A given number is answered by exactly one active bot.
- **AI enabled** — the on/off toggle for the paid AI fallback. Off = template-only; on = off-script input goes to the AI.
- **persona / system instructions** — the admin-written personality and guidance used only when AI is on (e.g. "You are Acme's friendly support assistant. Be concise. Only answer about Acme's products.").
- **re-show menu after AI** — whether, after an AI answer, the bot appends the menu again.
- **business hours** — optional window during which the bot is active (outside it, the bot can stay silent or send an after-hours template).
- **active** — whether the bot is running at all.
- **created / updated** — timestamps.

#### Bot Rule
- **belongs to** — the Bot this rule is part of.
- **trigger type** — keyword, contains, exact, or regex.
- **trigger value** — the text/pattern that fires this rule (e.g. `HELP`, `1`, `hours`).
- **reply template** — the v2 template the bot sends when this rule matches.
- **priority** — order in which rules are evaluated (first match wins).
- **is default case** — marks the rule as the fallback for off-menu input (used when AI is off, or when AI is on but declines to answer).

#### Knowledge Base Entry
- **belongs to** — the Bot whose AI fallback can draw on this entry.
- **title** — a short label for the entry.
- **source text** — the content the AI can answer from (pasted text, or extracted from an uploaded document).
- **source reference** — optional note of where it came from (filename, URL).
- **embedding vector** — the stored semantic representation used to find relevant entries for a given question.
- **created / updated** — timestamps.

#### AI Provider Config
- **provider** — Claude, OpenAI, or Ollama.
- **credentials** — API key (Claude/OpenAI) or endpoint URL (Ollama), stored in the database; an `.env` value can bootstrap a default.
- **enabled** — whether this provider may be used.
- **is default** — which provider is used when a bot's AI fallback fires.
- **model routing** — which model handles reply generation vs. which handles embeddings.
- **monthly budget** — a token/cost cap; when exceeded, the AI fallback degrades gracefully (falls back to the default-case template) instead of overspending.
- **usage this period** — running token/cost total against the budget.

#### Bot Reply Log (conversation log)
- **inbound message** — the message that arrived (sender, text, timestamp).
- **handled by bot** — which Bot processed it.
- **outcome** — whether a rule matched, the AI answered, the default-case fired, or nothing was sent.
- **matched rule / template** — which rule and template were used, if any.
- **reply text** — what the bot actually sent.
- **AI usage** — provider, model, tokens, and cost, if the AI answered.
- **timestamp** — when it was handled.

Relationships: a **Bot** has many **Bot Rules** and many **Knowledge Base Entries**, and is scoped to one or more **WhatsApp Numbers**. Each **Bot Rule** points at one **Message Template** (a v2 entity). **Bot Reply Log** rows reference the **Bot**, the inbound **Message**, and optionally the **Bot Rule** / **Message Template** used. **AI Provider Config** is global (not per-bot), consulted whenever any bot's AI fallback fires.

---

## Milestone 1 — Bots & Template Rules

Deliver the template-driven bot end-to-end with no AI: create a bot, give it a template flow, and watch it auto-reply on the real linked number. This is the free-tier bot.

### What gets built

- A **Bots** dashboard section: create/edit/delete bots, name them, and bind each to one or more linked numbers (enforcing one active bot per number).
- A rule builder per bot: add trigger→template rules (keyword / contains / exact / regex), reorder by priority, and pick which v2 template each rule replies with.
- A **default-case** designation on a rule, used when nothing else matches.
- The **bot runtime**: on inbound, find the bot for that number, evaluate rules in priority order, and auto-send the matched template's reply **through the existing anti-ban / health / consent engine** (respecting quiet hours, daily limits, blocked/opted-out contacts).
- Per-bot and global **kill switch** to pause all auto-replies instantly.
- Business-hours gating (optional) per bot.
- Every auto-reply is recorded in the **Bot Reply Log** (which rule/template answered) for later milestones to surface.
- **API + docs (per the cross-cutting requirement):** token-authed REST endpoints to create/read/update/delete bots and rules and bind numbers, all published in the OpenAPI spec, `/docs`, and the `/developers` portal with payload examples and console entries — shipped in this milestone, not deferred.

### What milestone 1 explicitly does NOT include

- Any AI, knowledge base, persona, or provider configuration (Milestones 2–3).
- The **preview/trigger-reply** endpoint and portal getting-started polish (Milestone 4) — the CRUD API for bots/rules ships now.
- The analytics/KPI view (Milestone 5) — logging happens now, the visualization comes later.
- Stateful multi-turn memory — routing is stateless keyword-to-template.

### Done when

The admin can create a bot, define a HELP-menu template flow with a default-case template, bind it to the linked test number, message that number from a second phone, and receive the correct auto-reply for a matching keyword and the default-case reply for off-menu input — all paced by the anti-ban engine.

---

## Milestone 2 — AI Provider Hub

Add the pluggable AI provider layer and its admin surface, so later milestones can generate replies. Nothing calls it in the bot flow yet — this milestone stands up and verifies the plumbing.

### What gets built

- An **AI Providers** admin screen: connect Claude (default), OpenAI, and/or Ollama; enter/rotate credentials (stored in the DB, with an `.env` value able to bootstrap a default); enable/disable each; choose the default provider.
- A **test-connection** button per provider that makes a real round-trip and reports success/failure.
- A single `AIProviderInterface` abstraction (adapted from `opentemplatesms`) so bot logic never depends on a specific vendor SDK.
- **Per-task model routing**: pick which model generates replies and which produces embeddings.
- A **monthly token/cost budget** with a running usage tally and graceful-degradation behavior when the cap is hit.
- **API + docs (per the cross-cutting requirement):** token-authed REST endpoints to read/update AI provider config, routing, and budget (never returning stored secrets), published in the OpenAPI spec, `/docs`, and the `/developers` portal — shipped in this milestone.

### What milestone 2 explicitly does NOT include

- Wiring AI into the bot runtime or any knowledge base (Milestone 3).
- The knowledge-base ingest UI or embeddings storage (Milestone 3).
- The **preview/trigger-reply** endpoint and portal getting-started polish (Milestone 4) — the provider-config API ships now.

### Done when

The admin can open the AI Providers screen, connect Claude with an API key, click "test connection" and see it succeed, set the default provider and model routing, and set a monthly budget — all persisted across a restart.

---

## Milestone 3 — AI Fallback (RAG)

Turn the paid AI toggle on: give each bot a knowledge base and a persona, and wire AI into the runtime so off-script input is answered from that knowledge instead of the default-case template.

### What gets built

- A per-bot **Knowledge Base** UI: add entries by pasting text or uploading a document; entries are chunked and embedded (via the provider hub's embedding route) and stored for semantic search.
- A per-bot **AI toggle**, **persona / system instructions** field, and **re-show-menu-after-AI** option.
- Runtime wiring: when no rule matches (what would otherwise hit the default-case template) **and** the bot's AI is on, retrieve the most relevant KB entries, generate a grounded reply via the default provider, send it through the anti-ban engine, and optionally re-show the menu.
- Graceful fallback: if AI is off, the provider errors, or the budget is exhausted, the bot uses the default-case template instead.
- The **Bot Reply Log** records AI outcomes with provider/model/token/cost detail.
- **API + docs (per the cross-cutting requirement):** token-authed REST endpoints to manage per-bot AI settings (toggle, persona, re-show-menu) and knowledge-base entries (add/list/delete), published in the OpenAPI spec, `/docs`, and the `/developers` portal with payload examples — shipped in this milestone.

### What milestone 3 explicitly does NOT include

- The **preview/trigger-reply** endpoint and final portal getting-started polish (Milestone 4) — the AI-settings and KB APIs ship now.
- The analytics dashboard (Milestone 5).
- Multi-turn memory, translation, or human handoff (v4).

### Done when

With AI enabled on a bot and a small knowledge base loaded, messaging the linked number with an off-menu free-form question returns a correct, KB-grounded AI answer followed by the menu; disabling the toggle makes the same question fall back to the default-case template.

---

## Milestone 4 — Bot Preview & Developer-Portal Completion

The per-feature APIs already shipped with Milestones 1–3 (per the cross-cutting API-first requirement). This milestone completes the *developer experience*: the preview/trigger-reply endpoint and a polished, end-to-end `/developers` walkthrough so a downstream team can self-serve with zero hand-holding.

### What gets built

- A **preview / trigger-reply** endpoint: given a bot and an inbound text, return what the bot *would* reply (rule match vs. AI vs. default-case, including the resolved template/AI text) without necessarily sending — so integrators can test flows safely.
- A consolidated **"Build a bot" getting-started guide** in the `/developers` portal that stitches the per-milestone endpoints into one narrative (create bot → add rules → load KB → enable AI → preview → go live).
- An audit pass ensuring every v3 endpoint from Milestones 1–3 is present in the OpenAPI spec, `/docs`, and the interactive console with request/response examples matching the existing v1/v2 doc quality — nothing undocumented.

### What milestone 4 explicitly does NOT include

- The analytics API and dashboard (Milestone 5).
- New bot behavior or new CRUD surface — the bot/rule/KB/AI-config APIs already exist from Milestones 1–3; this milestone adds only the preview endpoint and documentation completeness.

### Done when

Using only an API token and the `/developers` portal, a downstream developer can follow the getting-started guide to create a bot, add a rule and a KB entry, enable AI, and call the preview endpoint to see the exact reply the bot would send for a given inbound message — discovering every call purely from the docs.

---

## Milestone 5 — Conversation Log & Bot Analytics

Surface the Bot Reply Log as a human-readable conversation view plus KPIs, so the admin (and their clients) can see the bot working and justify the AI upgrade.

### What gets built

- A **Conversation Log** view: per-thread history of inbound messages and bot replies, showing for each whether a rule, the AI, or the default-case answered, and the text sent.
- **Bot analytics KPIs**: auto-resolution rate, rule-vs-AI share, AI token spend/cost, and deflection (messages handled without a human), filterable by date range and by bot/number.
- **CSV export** of the conversation log and KPIs.
- A **read-only analytics API** returning the same KPIs and conversation-log data for downstream dashboards, published in the OpenAPI spec, `/docs`, and the `/developers` portal with payload examples — per the cross-cutting requirement.

### What milestone 5 explicitly does NOT include

- Real-time streaming, a custom report builder, or scheduled email reports (v4).
- Any change to bot behavior — this milestone reads and visualizes existing log data.

### Done when

After the bot has handled several messages, the admin can open the Conversation Log, see each thread with the correct rule/AI/default-case attribution, view KPI tiles for a chosen date range, export a CSV, and fetch the same KPIs from the analytics API with a token.

---

## Milestone 6 — Turnkey Cloudways Deploy

Make deploying to Cloudways near-zero-touch on top of the existing `.htaccess` / PM2 setup, so shipping updates needs little or no manual server work.

### What gets built

- A single tracked configuration + hardened deploy path so a Cloudways Git deploy builds, installs, and (re)starts the app under PM2 with no hand-editing on the box.
- Idempotent handling of the v3 additions (new dependencies, DB migrations for the new entities, and any AI-provider `.env` bootstrap keys) as part of the deploy so a redeploy "just works".
- Verification and troubleshooting docs updated for v3 (what to check if the bot or AI provider doesn't come up through the Application URL vs. directly on `127.0.0.1:3000`).
- Confirmation that the `.htaccess` reverse proxy and PM2 process survive a redeploy without manual reconfiguration.

### What milestone 6 explicitly does NOT include

- Docker on Cloudways (unavailable on their PHP-stack VPS) or any change to the local Docker workflow.
- Multi-server / autoscaling / CI-pipeline automation beyond Cloudways' own Git-deploy feature.
- Provisioning a fresh box from scratch — this builds on the already-provisioned app.

### Done when

Pushing the v3 code through Cloudways' Git deploy and running the deploy script brings the app (bot + AI provider layer included) up cleanly under PM2, reachable through the Application URL, with the new database migrations applied and no manual server edits required.

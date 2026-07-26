# Milestone 2 — Link a Number · Log

## What's new in the app

- **Numbers page in the dashboard.** A new "Numbers" section where you add and manage your WhatsApp numbers.
- **Link by QR code.** Add a number, and a QR code appears — scan it from your phone (WhatsApp → Settings → Linked Devices → Link a device) to connect, exactly like WhatsApp Web. The QR auto-refreshes when it expires and the row flips to "linked" on its own once you scan.
- **Multiple numbers, live status.** Link as many numbers as you like; each shows a live status badge — connecting / linked / disconnected / flagged.
- **Auto-reconnect.** Linked numbers reconnect automatically after a service restart or a dropped connection, without re-scanning. You're only asked to re-scan if WhatsApp actually ends the session.
- **Re-link and unlink.** Re-link a disconnected number with one click, or unlink a number (logs it out of WaGuard and removes its session).
- **Status over the API.** Downstream apps can now call `GET /api/v1/numbers` and `GET /api/v1/numbers/:id` to see which numbers are available and their connection status. These appear in the live API docs automatically.

## What was built

**New dependency:** `@whiskeysockets/baileys` (7.0.0-rc13) — WhatsApp multi-device client over WebSocket, no headless browser. Plus `qrcode` for rendering the QR as a PNG data-URI.

**Files created:**
- `src/db/numbers.ts` — data access for the new `whatsapp_numbers` table: `createNumber`, `listNumbers`, `getNumber`, `setNumberStatus`, `setNumberLinked`, `deleteNumber`.
- `src/whatsapp/logger.ts` — a silent pino-compatible logger so Baileys doesn't spam stdout.
- `src/whatsapp/manager.ts` — the connection manager. In-memory `Map` of live sockets keyed by number id. Handles the Baileys `connection.update` lifecycle (QR → data-URI, `open` → linked + capture phone, `close` → transient reconnect vs. true logout), `creds.update` → `saveCreds`. Public API: `init()` (boot reconnect), `addNumber(label)`, `relink(id)`, `unlink(id)`, `list()`, `get(id)`. Merges persisted rows with live QR/status via `toView`.
- `src/routes/dashboard/numbers.ts` — `GET /numbers`, `POST /numbers`, `POST /numbers/:id/relink`, `POST /numbers/:id/unlink`, `GET /numbers/:id/qr` (JSON, polled by the page).
- `src/routes/api/numbers.ts` — `GET /api/v1/numbers` and `GET /api/v1/numbers/:id` (token-protected, schema'd; QR stripped from API responses).
- `src/views/numbers.ejs` — the Numbers page with the add form, per-number cards, QR box, and vanilla-JS polling that refreshes the QR and flips to "linked" without a manual reload.

**Files changed:**
- `src/db/migrations.ts` — added the `whatsapp_numbers` table (id, label, phone_number, status, created_at, linked_at).
- `src/server.ts` — registered the new routes; calls `whatsappManager.init()` in the background after listen to reconnect saved numbers.
- `src/plugins/swagger.ts` — added the `numbers` docs tag.
- `src/views/partials/head.ejs` — "Numbers" nav item is now a real link; added status-pill color variants and QR-box styles.
- `src/views/home.ejs` + `src/routes/dashboard/index.ts` — overview now shows linked/total number counts.
- `package.json` — **fixed the build script**: `rm -rf dist/views && cp -R src/views dist/views` (the previous `cp -r src/views dist/views` nested into `dist/views/views` on rebuilds, so newly added views 500'd).

**Endpoints added:**
- Dashboard (session): `GET /numbers`, `POST /numbers`, `POST /numbers/:id/relink`, `POST /numbers/:id/unlink`, `GET /numbers/:id/qr`.
- API (Bearer): `GET /api/v1/numbers`, `GET /api/v1/numbers/:id`.

## Decisions made during implementation (not pre-specified in the PRD)

- **Baileys loaded via `createRequire`** (it's CommonJS with a default export) to avoid ESM/CJS interop differences between `tsx` and compiled Node ESM.
- **Session credentials are stored as files** via Baileys' `useMultiFileAuthState` under `data/sessions/<numberId>/` (on the volume), rather than as a DB column. This is the standard, reliable Baileys pattern. The PRD's data-model "session credentials (encrypted)" field is realized as these on-disk session files; they are not additionally encrypted beyond filesystem permissions in v1.
- **QR delivered as a PNG data-URI** and surfaced through a small JSON polling endpoint (2s interval) rather than websockets — keeps the dashboard dependency-light.
- **`markOnlineOnConnect: false`** and a stable desktop browser fingerprint (`Browsers.macOS('Chrome')`) as early anti-ban-friendly defaults.
- **Reconnect policy:** on `connection.close`, `DisconnectReason.loggedOut` → mark `disconnected`, delete session files, require re-scan; any other close (including the normal `515 restart-required` after pairing) → auto-reconnect after 2s.
- **Unlink deletes the number row** (and session files) and calls Baileys `logout()`. The row is removed first so the close handler treats it as intentional.

## Verification (against the "Done when" criteria)

Tested non-Docker and in the Docker container (`docker compose`), 0 server errors in logs:
- Numbers page loads; adding a number starts Baileys and produces a **real WhatsApp QR** (confirmed both on host and inside the container — Baileys reaches WhatsApp and emits a QR data-URI).
- Live status via dashboard poll and via `GET /api/v1/numbers` / `:id`; unknown id → 404.
- **Unlink** → number removed from list and API.
- **Restart persistence:** the number row persists across a service restart; `manager.init()` re-opens the socket and the connection loop resumes (regenerates a fresh QR for a not-yet-linked number). DB and session dir live on the `data/` volume.
- Docker image rebuilds cleanly with Baileys' added (incl. native) dependencies via the builder stage.

**Not fully verifiable here (needs a physical phone):** the end-to-end "scan the QR → status flips to *linked* → restart → reconnects without re-scanning" round trip. The wiring (`creds.update` → `saveCreds` → `useMultiFileAuthState`, plus `init()` reconnect) is the canonical Baileys persistence pattern; `creds.json` is written on successful link. Worth a real-device smoke test before relying on it in production.

## What the next milestone (3 — Safe Sending) needs to know

- **Sending uses the live socket:** `whatsappManager` holds the connected `sock` per number id. Expose a helper (e.g. `getSocket(id)` / a `sendMessage` method) on the manager for Milestone 3 rather than reaching into the map directly. Only send when the number's status is `linked`.
- **Baileys send API:** `sock.sendMessage(jid, content)` where `jid` is `<digits>@s.whatsapp.net`. Add a phone→jid helper (mirror of the existing `jidToPhone`). `sock.sendPresenceUpdate('composing'|'paused', jid)` drives the typing indicator for the anti-ban engine.
- **New tables for M3:** `messages` and `queued_jobs` (see PRD data model). Also add the anti-ban/warm-up columns to `whatsapp_numbers` (warm-up stage, daily send count + date) — add them via new `CREATE`/`ALTER` statements in `migrations.ts`.
- **Pacing lives between the API and the socket:** the send API should enqueue (respond "queued") and a queue worker should apply delays/limits/typing before calling the manager's send. Do not send straight from the socket in the route handler.
- **Contacts:** M3/M5 introduce the `contacts` table; sending will need to resolve/create a Contact for the recipient.
- Follow the established patterns: schema'd routes under `/api/v1` (auto-docs), `requireApiToken` for API, `requireAdmin` for dashboard, EJS shell with `chrome:'app'`.

## Addendum — token API for the full linking flow (2026-07-26)

The initial M2 build only exposed the QR on the session-auth dashboard endpoint; the token API stripped it. Per user requirement (downstream systems need to drive linking themselves), added token-authenticated endpoints in `src/routes/api/numbers.ts` so a CRM can run the entire lifecycle over Bearer auth, no dashboard:

- `POST /api/v1/numbers` — create a number + start linking (201, returns the number).
- `GET /api/v1/numbers/:id/qr` — `{ status, qr, phone }` for polling (QR is a PNG data-URI while connecting, null once linked).
- `POST /api/v1/numbers/:id/relink` — restart the QR flow for a disconnected number.
- `DELETE /api/v1/numbers/:id` — unlink (logout + remove).

All schema'd, so they auto-appear in `/docs` and the OpenAPI spec. Verified end-to-end with a token: create→201, QR poll→real data-URI, no-token→401, relink→200, delete→`{ok:true}`, list empty, spec contains all paths, 0 errors. The dashboard's own `/numbers/:id/qr` (session auth) remains for the built-in UI.

## Real-device validation (2026-07-26) — the previously-pending item is now DONE

Confirmed on the running Docker instance with a real phone (number `15513423891`):
- Scanned the QR → number flipped to `status: linked`, phone captured, `linked_at` set.
- Full Baileys credentials persisted to `data/sessions/<id>/` (`creds.json`, pre-keys, app-state-sync keys, identity keys).
- **`docker compose restart` → the number auto-reconnected to `linked` without any re-scan** (init() reconnected from saved creds; logs clean, no errors).

So the entire Milestone 2 "Done when" is now verified end-to-end including the physical-phone round trip. The earlier "needs a real phone" caveat is resolved.

Also added after the initial build (see git history): token linking endpoints, `qr.png` (scannable image), `qr/live` (auto-refreshing HTML page), the dashboard showing each number's id, and a docs cleanup grouping routes into system / numbers / dashboard (internal).

## Deviations from the PRD

None in scope. Session credentials stored as files (see decisions) rather than a literal DB column — a standard, intentional realization of the data-model concept, not a scope change.

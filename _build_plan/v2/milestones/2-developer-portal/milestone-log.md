# Milestone 2 — Developer portal: docs + interactive API console

## What's new in the app

- **A new "Developers" page (`/developers`)** — a human-friendly API reference, distinct from the raw
  Swagger UI, grouped by area (System, Numbers, Messages, Contacts, Health).
- **Getting started section**: create a token, the service's base URL, and a first curl call to copy-paste.
- **Every endpoint is browsable**: expand it to see its description, a parameters table, a request-body
  example, and a ready-to-copy curl snippet.
- **A search box** filters the endpoint list by path or summary as you type.
- **A Webhooks section** documenting each payload shape (inbound message, status update, health event)
  with a signature-verification code snippet.
- **A live "try it" console**: pick an endpoint, fill in its parameters (and an editable JSON body where
  relevant), paste an API token, and press Send to call the real running service — the response (status,
  timing, and formatted body) appears right there in the panel.
- The sidebar, footer, account menu, and Overview page's "API for downstream apps" card now point to the
  new Developers page; the raw Swagger UI (`/docs`) and the OpenAPI spec download remain available as
  secondary links.

## What was built

### New files
- `src/routes/dashboard/portal.ts` — `portalRoutes(app)` registers `GET /developers`. `buildPortalData(app)`
  builds the entire view model by calling `app.swagger()` at request time and walking `spec.paths`,
  grouping operations by tag (fixed order: system, numbers, messages, contacts, health — mirrors the tag
  order in `src/plugins/swagger.ts`), skipping the `dashboard (internal)` tag. For each operation it
  extracts path/query parameters, the JSON request-body schema, builds a plausible example value from that
  schema (`exampleFromSchema()`), and a copyable curl snippet (`buildCurl()`, using `config.publicBaseUrl`).
  It also pulls the `Webhook*` schemas out of `spec.components.schemas` for the Webhooks section.
- `src/views/portal.ejs` — the page itself: getting-started, per-tag endpoint-reference cards (each
  endpoint an expandable `<details>`), the Webhooks section, and the interactive console. The console is
  plain client-side JS (no new dependency): an embedded `<script type="application/json">` blob carries
  the console-eligible endpoint list; a grouped `<select>` renders path/query param inputs and a JSON body
  textarea per endpoint; **Send** does a same-origin `fetch()` with the pasted Bearer token and renders the
  status/timing/body. The token is remembered in `localStorage`.

### Changed files
- `src/server.ts` — imports and registers `portalRoutes`.
- `src/views/partials/head.ejs` — sidebar "API Docs" entry and account-menu link now point to `/developers`
  (label "Developers"); sidebar link gets `active` highlighting.
- `src/views/partials/foot.ejs` — footer "API Docs" link → `/developers`.
- `src/views/home.ejs` — Overview's API card: primary button is now "Open developer portal" → `/developers`;
  "Download OpenAPI spec" and a new "Raw Swagger UI" (`/docs`) link are kept as secondary actions.
- `README.md` — added a "What's here (v2 · Milestone 2)" section.

## Decisions made during implementation (not pre-specified)

- **Generate everything from the live OpenAPI spec rather than hand-writing duplicate docs.** The API
  already declares tags/summary/description/params/body/responses on every route (`src/routes/api/*.ts`)
  for `@fastify/swagger`; reusing `app.swagger()` means the portal can never drift from the real contract.
- **The portal route is public** (no `requireAdmin`), matching `/docs`'s existing posture — downstream
  developers consuming the API won't have an admin dashboard session.
- **Console scope is deliberately narrower than the full endpoint list.** The multipart file-upload
  endpoint (`POST /api/v1/messages/upload`) and binary/HTML responses (`GET .../qr.png`, `GET .../qr/live`,
  `GET .../media`) don't fit a clean JSON round-trip, so they're fully documented (description, params,
  curl snippet) but excluded from the console's endpoint picker, with a note pointing at the curl snippet
  instead of faking a broken form.
- **`exampleFromSchema()`** is a small generic JSON-schema walker (object/array/string/number/boolean/enum)
  used for both the docs' body-example rendering and the console's pre-filled, editable body textarea —
  one code path instead of two.

## Deviations from the PRD

- None material. The PRD's "does NOT include" list for M2 (client SDKs/codegen, versioned docs history,
  saved request collections/environments) was followed as-is — none of those were built.

## Verification performed

- `npm run build && node dist/server.js` on host, against an **isolated copy** of `./data` (never touched
  the live container's database or the running container mid-test).
- A full 7-step Playwright browser walkthrough against the running host instance: page load + branded
  shell + all 5 endpoint groups render (23 endpoints); search filter narrows correctly; expanding an
  endpoint shows its curl snippet and a working copy button; the console's `GET /api/v1/numbers` with a
  real token returns a real 200 with the actual linked numbers; a path-param endpoint blocks submission
  client-side when the required param is empty, then succeeds with a real id; a POST endpoint's body
  textarea pre-fills with valid, editable JSON. **All 7 steps passed.**
- The browser test surfaced one real bug: `pre.snippet` had `position:relative`, which (being later in the
  DOM than the absolutely-positioned `.copy-btn` sibling) created a stacking context that painted over and
  intercepted clicks on the copy button. Fixed by dropping `position:relative` from `pre.snippet` and adding
  `z-index:1` to `.copy-btn`; re-verified after the fix.
- Docker image rebuilt twice (`docker compose up -d --build`) and re-checked `/developers`, `/docs`, and
  `/openapi.json` all return 200 against the real container (the `./data` bind mount was never at risk —
  it's a host directory, not a named volume).

## What the next milestone needs to know

- **The endpoint-reference/console pattern is reusable.** When M3 adds new tagged routes (`contacts`
  already exists; a new `templates`/`buttons` tag if added), they'll appear in `/developers` automatically
  as long as the route schema declares `tags`, `summary`, and `description` — no portal code changes needed
  unless a new tag needs adding to `TAG_ORDER`/`TAG_LABELS` in `src/routes/dashboard/portal.ts`.
- **Console-exclusion pattern**: if M3's contact-import endpoint is multipart (CSV upload), follow the same
  `consoleSupported()` convention in `portal.ts` (currently keys off path suffixes `/upload`, `/qr.png`,
  `/qr/live`, and GET `/media` — extend that function rather than special-casing in the view).
- **Nav "Soon" → real link pattern** (established in M1, followed here for Developers) still applies:
  flip `.nav a.soon` to a real `<a href>` + `active` key in `head.ejs` when Templates/Broadcasts land.

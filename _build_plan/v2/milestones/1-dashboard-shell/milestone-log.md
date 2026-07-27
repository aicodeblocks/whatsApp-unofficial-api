# Milestone 1 — Design system, branded shell & Overview home

## What's new in the app

- **A branded, professional dashboard shell** on every page: a sticky top header with the WaGuard
  logo mark + wordmark, a live "N linked" connection indicator, a light/dark theme toggle, and an
  account menu (API tokens, API docs, log out).
- **A consistent design system** — refreshed emerald-on-zinc palette, cards, buttons, pills, tables,
  and page headers — so Numbers, Send & Queue, Contacts, Webhooks, Health, and API Tokens all look
  like one product.
- **A refined icon left-navigation** covering every area, including placeholders for the areas landing
  in later milestones (Templates, Broadcasts, Analytics — shown as "Soon").
- **A persistent light/dark theme toggle** that follows your operating-system preference by default and
  remembers your explicit choice across visits.
- **A redesigned Overview home** that shows the true, live state of the service at a glance:
  - a **system-health strip** (numbers linked, queue depth, at-risk numbers, webhook health);
  - a **status card per capability** (Numbers, Send & Queue, Receiving, Webhooks, Health, Contacts),
    each with a real count and an active / idle / needs-attention status dot;
  - **quick actions** (link a number, send a test, docs, webhooks);
  - a **recent-activity feed** merging the latest sent/received messages, health events, and webhook
    deliveries.
- A **branded footer** on every page showing the app version and links to API Docs, Health, and status.
- The layout is **responsive down to tablet/phone width** — the sidebar collapses behind a menu button.

## What was built

### New files
- `src/types/fastify-view.d.ts` — module augmentation declaring `FastifyReply.locals` (see decisions).

### Changed files
- `src/config.ts` — added `appVersion`, read from `package.json` at boot (`resolveAppVersion()`),
  shown in the footer.
- `src/server.ts` — added one global `onRequest` hook that injects the shared shell context
  (`appName`, `appVersion`, `numberCount`, `linkedCount`) into `reply.locals`, which `@fastify/view`
  merges into every rendered view. Skips `/api`, `/openapi`, and `/docs`. This is why no per-route
  handler had to change to get the header/footer data.
- `src/views/partials/head.ejs` — **largest change.** Full design-token layer (emerald accent scale +
  zinc neutrals; light on `:root`, dark via `@media (prefers-color-scheme: dark)` **and**
  `:root[data-theme="dark"]`, with `:root[data-theme="light"]` forcing light so the toggle always
  wins); a no-flash inline theme script exposing `window.__toggleTheme()`; the branded app shell
  (`.appbar` with logo mark, connection indicator, theme toggle, account menu); the icon sidebar nav;
  restyled shared components; and Overview-specific components (`.health-strip`, `.metric`,
  `.stat-grid`, `.status-card`, `.status-dot`, `.activity-feed`). Responsive rules collapse the sidebar
  under a menu button ≤960px.
- `src/views/partials/foot.ejs` — closes the new shell (`main` → `footer` → `main-col` → `layout` →
  `app`) and renders the branded footer (version + links) for app chrome; unchanged minimal close for
  auth chrome.
- `src/views/home.ejs` — rewritten as the live Overview (health strip, status cards, quick actions,
  activity feed, API section).
- `src/routes/dashboard/index.ts` — `GET /` now calls a new `buildOverview()` helper that computes the
  status cards, health strip, and merged activity feed from live data.
- `src/db/messages.ts` — added `countMessages(direction?)`.
- `src/db/contacts.ts` — added `contactCounts()` (total + per-consent-status breakdown).

### Data sources for the Overview (all existing v1 helpers)
- Numbers / linked / health: `whatsappManager.list()` (returns `NumberView extends WhatsAppNumber`,
  so `status` + `health_status` are available).
- Queue depth: sum of `jobCountsForNumber(n.id).waiting` across numbers.
- Receiving / sent totals: `countMessages('inbound'|'outbound')`.
- Webhooks: `getEndpoint()` (single-endpoint model) + `recentDeliveries(50)`.
- Contacts: `contactCounts()`.
- Activity feed: `listMessages(8)` + `listHealthEvents(undefined, 8)` + `recentDeliveries(8)`, merged
  and sorted by timestamp, top 10; timestamps formatted with `humanInTz()` from `src/time.ts`.

## Decisions made during implementation (not pre-specified)

- **Shell data via `reply.locals` + a global hook**, rather than editing every route to pass header/footer
  data. `@fastify/view` v10 supports `reply.locals` at runtime but does not augment the `FastifyReply`
  type with it, so `src/types/fastify-view.d.ts` declares it. The hook runs after the view plugin's own
  `onRequest` (which resets `locals` to `{}`), so it spreads safely.
- **CSS stays inline in `head.ejs`** (no `@fastify/static` added) to preserve v1's dependency-light,
  no-static-assets approach. It's organized into token + component + Overview + responsive layers.
- **Theme model:** OS preference by default; the toggle sets `data-theme` on `<html>` persisted in
  `localStorage['waguard-theme']`. Dark tokens are declared twice (media query scoped with
  `:not([data-theme="light"])`, and `[data-theme="dark"]`) so an explicit choice always overrides the OS.
- **Logo** is a self-contained inline SVG shield-with-chat mark (themed via `currentColor`), matching the
  "guard / anti-ban" identity; nav/activity icons are inline stroke SVGs (Lucide-style), no icon library.
- **"Soon" nav items** (Templates, Broadcasts, Analytics) reuse v1's existing `.nav a.soon` disabled+tag
  pattern; they become live links in milestones 3–5.
- Status-dot semantics: **active** (green) = doing work / healthy with data, **idle** (grey) = configured
  but nothing happening, **needs-attention** (amber) = at-risk/flagged numbers or recent webhook failures.

## Deviations from the PRD
- None material. The PRD's Webhooks card mentions "endpoints configured"; v1 is a **single**-endpoint model
  (`getEndpoint()`), so the card reflects that one endpoint's active/health state rather than a count.

## Verification performed
- `npm run typecheck` — clean.
- `npm run build` + `node dist/server.js` (the exact command the Docker image runs) on host — boots clean.
  (Note: `npm run dev` / tsx fails on this host because the Baileys 7 transitive `whatsapp-rust-bridge`
  WASM package only exposes an `import` condition that Node 24 + tsx's CJS resolver rejects; the compiled
  ESM path resolves it fine. Pre-existing, unrelated to this milestone.)
- Full auth flow (`/setup` → session → `/`) and all dashboard pages (`/numbers /queue /contacts /webhooks
  /health /tokens`) return 200 and render the branded shell (appbar + footer) with the correct active nav.
- **Live-status accuracy** exercised end-to-end: adding contacts via the consent API moved the Contacts
  card 0 → 2 with note "1 opted-in · 1 blocked"; configuring a webhook endpoint flipped the Webhooks card
  from "No endpoint configured" (idle) to "Endpoint ready" (active). Health strip renders correct values.
- Docker image builds and runs the same compiled entrypoint (parity with host).

## What the next milestone needs to know
- **To add a nav item:** edit `src/views/partials/head.ejs` (the `.nav` block) — flip the relevant `.soon`
  placeholder (Templates → M3, Broadcasts → M4, Analytics → M5) into a real `<a href>` with an `active`
  key, and set that key via `active: '<key>'` in the page's `include('partials/head', {...})`.
- **Design-system components** to reuse on new pages: `.card`, `.btn`/`.btn.secondary`/`.btn.danger`,
  `.pill(.on/.warn/.bad)`, `.table-wrap`+`table`, `.page-head`, `.stat-grid`/`.status-card`/`.status-dot`,
  `.health-strip`/`.metric`, `.alert`. All tokens are CSS vars (`--accent`, `--panel`, `--muted`, etc.).
- **Shell context** (`appName`, `appVersion`, `numberCount`, `linkedCount`) is available in every view via
  `reply.locals` — no need to pass it from new routes. Add more shared shell data in the `server.ts` hook.
- **Count helpers** `countMessages()` and `contactCounts()` exist for building live tiles; follow the same
  prepared-statement pattern for new rollups (M5 analytics will likely add its own).
- The Overview aggregation lives in `buildOverview()` in `src/routes/dashboard/index.ts`; extend it there
  when new capabilities (templates/broadcasts/analytics) should surface on the home page.

# Milestone 5 — Analytics & reporting

## What's new in the app

- A new **Analytics page** with a date-range picker (defaults to the last 30 days) and
  a number filter, showing:
  - **KPI tiles**: total sent, delivery rate, read rate, failures, inbound volume for
    the selected range.
  - **Sends over time**: a stacked bar chart of outbound messages per day, broken down
    by their current status (delivered / read / sent / failed).
  - **Inbound volume**: a bar chart of received messages per day.
  - **Health incidents over time**: a stacked bar chart of health events per day by
    severity (critical / warning / info).
  - **Per-number breakdown**: a bar chart plus a full table (sent/delivered/read/
    failed/received) for every linked number in the range.
  - **Campaign performance**: a table of every broadcast campaign created in the
    range with its live send/delivery/read/failure counts, linking back to its
    Broadcasts detail page.
- **CSV export** of the selected range's per-number daily stats, one click from the
  Analytics page.
- A read-only **Analytics API** (`/api/v1/analytics/summary|daily|campaigns|health`)
  so downstream systems can pull the same numbers programmatically — auto-documented
  in the developer portal alongside every other API area.

## What was built

### New files
- `src/db/analytics.ts` — the reporting layer: `ensureDailyStatsFor()` (the
  cache-fill/rollup), `dailyStatsInRange()`, `kpiTotals()`, `perNumberBreakdown()`,
  `campaignPerformanceInRange()` (batches the **existing** `campaignProgress()` from
  M4's `db/broadcasts.ts` — no new per-campaign counting logic), `healthIncidentsByDay()`,
  and a hand-rolled `exportCsv()` (mirrors M3's hand-rolled `src/lib/csv.ts` parser —
  no new dependency).
- `src/routes/dashboard/analytics.ts` + `src/views/analytics.ejs` — the Analytics
  page and its CSV-export route. Charts render via a small vanilla-JS SVG-drawing
  helper embedded directly in the view (`drawStackedBars`/`drawBars`) — no charting
  library, no CDN, following the app's established "embedded JSON + inline `<script>`"
  pattern from the M2 API console and M3 template preview.
- `src/routes/api/analytics.ts` — the four read-only API endpoints, thin wrappers
  around the same `db/analytics.ts` functions the dashboard route uses.

### Changed files
- `src/db/migrations.ts` — new `daily_stats` table (composite `PRIMARY KEY
  (number_id, date)`), plus `idx_messages_created`/`idx_health_created` (bare
  `created_at` indexes — the existing indexes on both tables are all number-scoped
  composites, which don't help an all-numbers date-range scan).
- `src/time.ts` — added `dateKeyInTz()` (instant → `YYYY-MM-DD` in the display
  timezone, same `Intl.DateTimeFormat('en-CA', ...)` technique `isoInTz` already
  uses), `todayKeyInTz()`, and `dayKeysBetween()`.
- `src/views/partials/head.ejs` — "Analytics" nav item flipped from `.soon` to a
  real link.
- `src/routes/dashboard/portal.ts`, `src/plugins/swagger.ts` — `analytics` tag
  registered per the checklist M3/M4 both documented for adding a new API tag.
- `src/server.ts` — registered `analyticsApiRoutes` and `analyticsDashboardRoutes`.

## Decisions made during implementation (not pre-specified)

- **Day buckets are display-timezone calendar days, not UTC.** Bucketing by
  `dateKeyInTz()` rather than SQLite's UTC-based `date()` function keeps a chart's
  "today" aligned with the operator's actual calendar day (e.g. `APP_TZ=America/New_York`)
  instead of shifting by the UTC offset. To avoid needing exact UTC day-boundary math
  for an arbitrary IANA timezone, the rollup scans a coarse, deliberately over-wide UTC
  window around the target range and buckets each row precisely in JS, discarding rows
  outside the exact day — simpler and more robust than computing day boundaries directly.
- **The `daily_stats` rollup is lazy/on-demand, not a scheduled job.** There's no existing
  cron/daily-job precedent in the codebase to hook into, so `ensureDailyStatsFor()` fills
  in whatever's missing the first time a range is viewed and reads from cache thereafter —
  the same "materialize/self-heal on read" shape M4's `refreshCampaignStatus()` already
  established. Satisfies the PRD's "keeps charts fast without recomputing all history"
  without introducing a new scheduler.
- **A settle window (today + the last 2 days) is never cached**, always computed live.
  A message can sit `queued` for a while under anti-ban pacing or a health cool-off, so a
  day's stats aren't necessarily final the moment the calendar day ends; caching too
  eagerly would let a day's numbers go stale forever (the cache is filled once, not
  incrementally updated). This is a documented simplification, not a guarantee every
  message is fully settled by day+3 — an edge case where a message is held in the queue
  for an unusually long time (e.g. an extended health cool-off) could still cause the
  cached day it was created on to under-count it. Acceptable for a reporting dashboard,
  not billing-grade.
- **Message counts are bucketed by current status, not a status-transition log** — there's
  no event-time history of *when* a message moved from sent→delivered→read (only the
  current `status` + `updated_at`), so "delivered on day X" really means "created on day X
  and currently delivered," using `created_at` as the bucketing timestamp for every count.
  This matches how the existing `activitySnapshot()` health helper already reasons about
  message counts, so it's consistent with prior art in the codebase, not a new convention.
- **Campaign performance filters by campaign `created_at`** within the range (not by when
  its messages were sent) — the simplest and most intuitive interpretation of "campaigns in
  this range," and ISO-8601 strings sort/compare correctly as plain strings, so no date
  parsing was needed for the filter.
- **Token API added** (per explicit user decision, breaking M3's dashboard-only precedent
  the same way M4 did) — four read-only endpoints, no write/mutation surface at all.

## Deviations from the PRD

- None material to the "Done when" criteria. Health incidents aren't part of the PRD's
  Daily Stats entity (which only lists sent/delivered/read/failed/received) — implemented
  as a separate un-cached range query (`healthIncidentsByDay()`) rather than folded into
  the `daily_stats` rollup table, since health-event volume is much lower than message
  volume and doesn't need the same caching treatment.

## Verification performed

- `npm run typecheck` — clean. `npm run build && node dist/server.js` — clean boot on a
  fresh data dir (migrations, including the new `daily_stats` table and indexes, ran
  without error).
- **Functional smoke test on a throwaway instance** with synthetically seeded historical
  data (50 outbound messages across 10 days with a deliberate status mix, 10 inbound
  messages, 2 health events): the `/api/v1/analytics/summary` totals, the `/analytics/
  export.csv` sums, and the dashboard page's KPI tiles all matched the manually-computed
  `sqlite3` counts **exactly** (sent 20 / delivered 10 / read 10 / failed 10 / received 10,
  delivery rate 40%, read rate 20%). Confirmed the rollup actually caches: 27 of 30 days
  in range were written to `daily_stats` after the first load (the 3-day settle window
  correctly excluded), and re-querying the same range read from the cache.
- **Live-verified against the real Docker container and its real historical data**
  (M4's live-test messages, campaign, and health events): rebuilt the container (the
  linked number reconnected `linked` cleanly, matching the M3/M4 pattern — no live
  sends were needed for this milestone since it's read-only reporting, so quiet hours
  were never touched). `/api/v1/analytics/summary` exactly matched a manual `sqlite3`
  count of the real `messages` table (3 sent, 0 delivered, 20 read, 0 failed, 12 received,
  with the 2 still-`queued` messages correctly excluded as non-terminal); the campaigns
  endpoint correctly returned "M4 Live Broadcast Test" with its real progress; the health
  endpoint's total incident count (424) matched a manual `sqlite3` group-by exactly.
  **User visually confirmed** the live `/analytics` page in a browser: KPI tiles, all
  three SVG charts actually drawing bars, the per-number table, and the campaign
  performance table all rendering correctly.
- Confirmed `/developers` correctly lists the new `analytics` API group.
- The temporary API token created for live verification was revoked immediately after.

## What v3 (or any future work) needs to know

- **v2 is now feature-complete** — M1 through M5 are all done. `_build_plan/v2/` is a
  temporary planning artifact per its own header note and can be deleted once this is
  reviewed.
- **`daily_stats` only covers message counts** (sent/delivered/read/failed/received per
  number per day) — any future analytics work (e.g. a v3 custom report builder) that
  needs finer granularity (hourly, per-template, per-broadcast) will need new columns or
  a new table; nothing here assumes it'll be extended in place.
- **The settle-window caching gap** (documented above) is worth revisiting if send delays
  routinely exceed a couple of days under heavy health cool-off — currently a low-severity,
  low-likelihood simplification.
- **`dateKeyInTz()`/`dayKeysBetween()` in `src/time.ts`** are now the reusable building
  blocks for any future calendar-day-bucketed feature — no need to re-derive the
  UTC-window-then-JS-bucket technique.

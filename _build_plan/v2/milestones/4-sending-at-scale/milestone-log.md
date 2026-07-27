# Milestone 4 — Sending at scale: broadcasts + group messaging

## What's new in the app

- **Broadcast campaigns** (new "Broadcasts" page): build a campaign — name, sending
  number, target contact list, a saved template or inline text/media, optional buttons,
  optional future start time — and save it as a **draft** first. The draft view shows a
  recipient-count preview and an estimated send window under the number's current daily
  pacing limit before you commit anything.
- **Launch, watch, and control campaigns**: launching fans the campaign out to every
  eligible recipient in the list, paced by the exact same anti-ban queue as a single send.
  The campaign page shows live progress (queued/sent/delivered/read/failed) that
  auto-refreshes, and you can **pause**, **resume**, or **cancel** it at any point — pausing
  holds remaining sends without losing your place; cancelling stops them for good. Blocked
  and consent-unknown contacts (per your policy) are automatically skipped and counted.
- **WhatsApp group messaging**: sync the groups a linked number belongs to (with
  participant counts) and send a text, media, or templated message to any of them — also
  through the paced queue, with the same buttons-as-numbered-text-list rendering M3
  established for 1:1 sends.
- **Inbound group messages are now captured**, correctly attributed to the actual sending
  participant (not the group), flagged `is_group: true`, and pushed via the same
  `message.inbound` webhook downstream systems already use — with one deliberate
  exception: a "STOP" keyword typed inside a group chat no longer auto-blocks that
  person's direct messages (a group opt-out isn't a personal one).
- A **Broadcasts API and a Groups API** (`/api/v1/broadcasts/*`, `/api/v1/groups/*`) let
  downstream systems create/launch/control campaigns and sync/send to groups
  programmatically — both auto-documented in the `/developers` portal alongside every
  other API area.

## What was built

### New files
- `src/db/broadcasts.ts` — `broadcast_campaigns` CRUD, `campaignProgress()` (live
  per-status message counts), `refreshCampaignStatus()` (self-healing rollup: flips
  `scheduled`→`sending` once the start time passes, and `sending`→`completed` once no
  message tied to the campaign has an active job left — called lazily wherever a campaign
  is read, same pattern as the M1 Overview page), `cancelWaitingJobsForCampaign()`.
- `src/db/groups.ts` — `groups` CRUD; `upsertGroups()` does an
  `ON CONFLICT(number_id, provider_group_id) DO UPDATE` upsert; `getGroupByProviderId()`
  is used by inbound capture to attach a synced group to an inbound message.
- `src/whatsapp/broadcast.ts` — `launchCampaign()`, the one place a draft turns into real
  sends: loops the target list, calls the **existing** `enqueueMessage()` per recipient
  (reusing all of its consent/validation/template/placeholder logic unchanged), counts
  `EnqueueError`s as skips, and records the outcome on the campaign row.
- `src/routes/dashboard/broadcasts.ts` + `src/views/broadcasts.ejs` +
  `src/views/broadcast-detail.ejs` — the Broadcasts page (campaign list, create-draft
  form, groups section) and the campaign detail page (draft preview/launch, or live
  progress + pause/resume/cancel). Progress polling reuses `queue.ejs`'s established
  `fetch` + `DOMParser` + `innerHTML`-swap pattern — no new client-side dependency.
- `src/routes/api/broadcasts.ts`, `src/routes/api/groups.ts` — the token API for both
  features, tagged `broadcasts`/`groups`.
- `src/lib/buttons-form.ts` — the `collectButtons()` form-field helper, extracted out of
  `queue.ts` (which was the only prior user) so the new Broadcasts routes could reuse it
  without duplicating it.

### Changed files
- `src/db/migrations.ts` — new `broadcast_campaigns` and `groups` tables; `messages`
  gains nullable `group_id`/`broadcast_id`. **`messages.contact_id` had to become
  nullable** (group messages have no individual contact) — since SQLite can't relax a
  `NOT NULL` via `ALTER TABLE`, added `ensureMessagesContactIdNullable()`, a one-time
  guarded rebuild (create-copy-drop-rename) that runs only if an existing install still
  has the old constraint; verified against a real copy of the production DB (see
  Verification) with all 28 existing messages and their `template_id` values intact
  afterward.
- `src/db/messages.ts` — `contact_id` is now `string | null` throughout; `NewMessage`/
  `NewInboundMessage` gained optional `group_id`/`broadcast_id`.
- `src/whatsapp/enqueue.ts` — the template-resolution + type/content validation block
  (previously inline in `enqueueMessage`) was extracted into a private `resolveContent()`
  helper shared with the new `enqueueGroupMessage()`; `EnqueueInput` gained
  `broadcast_id`. `enqueueGroupMessage()` mirrors `enqueueMessage()` but skips
  contact/consent resolution and `{{placeholder}}` fill entirely — a group isn't a
  consent-tracked Contact.
- `src/whatsapp/queue.ts` — `processJob` gained a campaign gate (cancelled → fail the
  job immediately; paused → hold it, same shape as the existing per-number pause).
  `releaseSend` now branches on `message.group_id` vs `message.contact_id`: group sends
  skip the `existsOnWhatsApp` presence check and `markContacted` (neither applies to a
  group), everything else (typing simulation, `buildContent`, pacing/cooldown) is
  unchanged and JID-agnostic.
- `src/whatsapp/manager.ts` — added `listGroups()` (wraps Baileys'
  `sock.groupFetchAllParticipating()`); the inbound `messages.upsert` handler no longer
  filters out `@g.us` — group messages are now resolved to their actual sender via
  `raw.key.participant` (falling back to `participantAlt` for LID-addressed senders,
  mirroring the existing `remoteJidAlt` handling for 1:1 chats).
- `src/whatsapp/inbound.ts` — `handleInbound()` takes an optional `groupJid`, attaches
  `group_id` via `getGroupByProviderId()` if the group has been synced, and **skips
  STOP-keyword auto-block for group messages** (a new deliberate decision — see below).
- `src/whatsapp/webhooks.ts` — `inboundPayload`/`statusPayload` add `is_group`, and
  null-guard the `getContact()` lookup now that `contact_id` can be null.
- `src/routes/dashboard/queue.ts` — `recentMessages()` shows "Group" instead of a phone
  number for group-directed rows; `collectButtons()` now imported from the new shared
  `src/lib/buttons-form.ts` instead of being defined inline.
- `src/routes/api/messages.ts` — `messageSchema` documents the now-nullable `contact_id`
  and the new `group_id`/`broadcast_id` fields.
- `src/db/buttons.ts` — `ButtonOwnerType` gained `'campaign'` (buttons attached directly
  to a campaign, copied onto each recipient's message at launch).
- `src/routes/dashboard/portal.ts`, `src/plugins/swagger.ts` — `broadcasts`/`groups` tags
  registered (`TAG_ORDER`/`TAG_LABELS`, swagger tag descriptions) per the checklist M3's
  log documented for adding a brand-new API tag.
- `src/views/partials/head.ejs` — "Broadcasts" nav item flipped from `.soon` to a real
  link (no separate "Groups" nav item — group messaging lives inside the Broadcasts page,
  matching the fixed nav list M1 established).

## Decisions made during implementation (not pre-specified)

- **Token API included, breaking from M3's dashboard-only precedent** — an explicit user
  decision for this milestone (M3's contacts/templates stayed dashboard-only; broadcasts
  and groups ship a full `/api/v1/broadcasts` + `/api/v1/groups` surface alongside the UI).
- **Two-step draft → launch flow** for campaigns (also an explicit user decision) — a
  campaign is created as a `draft` with no jobs yet; the detail page shows a recipient
  count and an estimated send window (`recipients ÷ current daily limit`, rounded up to
  days, labeled as an approximation) before a separate Launch action commits to real sends.
- **Groups are not Contacts.** No consent status, no `{{placeholder}}` fill, no
  `existsOnWhatsApp` presence check — a WhatsApp group is a different kind of destination
  and the group-send path (`enqueueGroupMessage`) deliberately doesn't force it through
  the individual-recipient machinery, while still sharing the exact same paced queue,
  health gate, and quiet-hours gate as everything else.
- **STOP-keyword auto-block only fires on direct messages, not group messages** — decided
  during inbound-capture implementation. Typing "stop" inside a group chat isn't a
  personal opt-out signal from that sender the way a direct "STOP" reply is; auto-blocking
  someone's DMs because of something they said in an unrelated group felt like the wrong
  default. Group inbound is still fully captured and webhooked either way.
- **Campaign completion is a lazy, self-healing rollup**, not an event pushed from the
  queue worker: `refreshCampaignStatus()` recomputes from live job counts every time a
  campaign is read (list, detail, API) rather than `queue.ts` reaching into campaign state
  on every job completion. Keeps the queue worker's only new responsibility a simple
  pause/cancel gate check, and keeps campaign-status logic in one place.
- **Recipient pre-filtering delegates entirely to `enqueueMessage()`'s existing consent
  checks** — `launchCampaign()` doesn't re-implement the blocked/unknown-policy logic; it
  just calls `enqueueMessage()` per recipient and counts `EnqueueError`s as skips. Verified
  live: blocking a contact and relaunching produced `total_recipients: 0, skipped_count: 1`
  with no code path duplicated.
- **`messages.contact_id` nullability required a one-time table rebuild**, not a plain
  `ALTER TABLE ADD COLUMN` (SQLite can't relax `NOT NULL` in place). This was tested
  against an isolated copy of the real production database (DB file only — per the M3
  standing rule, `data/sessions/` is never copied) before ever touching the live container,
  and again implicitly on the live rebuild itself.

## Deviations from the PRD

- None material to the "Done when" criteria. The PRD's group messaging section doesn't
  specify whether STOP-in-group should auto-block — the decision above is a judgment call
  made during implementation, not a contradiction of anything specified.

## Verification performed

- `npm run typecheck` — clean.
- `npm run build && node dist/server.js` — clean boot on a fresh (empty) data dir.
- **Migration-rebuild tested against a real copy of the production DB** (file only, no
  `sessions/`): all 28 pre-existing messages preserved, `contact_id` correctly nullable
  afterward, existing `template_id` values intact, new tables present.
- **Full functional smoke test** on a throwaway instance: token creation, list/contact
  creation, campaign draft → launch → pause → resume → cancel via the API, dashboard pages
  rendering, groups sync/list/send API calls, and a blocked-recipient skip
  (`total_recipients: 0, skipped_count: 1`) — all behaved as designed.
- **Live verification against the real linked number and Docker container** (quiet hours
  briefly disabled via `.env` and restored immediately after, mirroring M3's approach;
  `./data` untouched otherwise): the container was rebuilt and the linked number
  reconnected `linked` cleanly.
  - **Groups**: synced the real linked number's groups (found a real 393-member group —
    deliberately *not* used for a test send); the user created a small 3-person test group
    ("Sample work") from their phone; synced it, sent a text message to it via the API —
    confirmed **delivered on real devices**.
  - **Broadcasts**: opted in two real test numbers, built a list, launched a campaign with
    `{{name}}` placeholder content and two quick-reply buttons to both — confirmed
    **delivered on real devices** with the buttons rendering as the established numbered
    text-list fallback. Paused mid-flight (confirmed the second recipient's job held, not
    sent, for the pause duration), resumed, and watched it reach `completed` with
    `delivered: 2` via the self-healing status rollup.
  - **Inbound group capture**: a real group participant sent a message into the test
    group — confirmed captured in the database with the correct `group_id`, attributed to
    the actual sending participant (not the group JID), and delivered via a live webhook
    receiver with `is_group: true`. A parallel 1:1 reply from the same test flow confirmed
    `is_group: false` on ordinary inbound messages, and outbound `message.status` events
    for the group send correctly showed `to: null, is_group: true`.
  - Test artifacts: the temporary API token used for live testing was revoked immediately
    after; `.env`'s temporary `QUIET_HOURS_ENABLED=false` was removed and the container
    rebuilt again to restore normal production behavior before finishing.

## What the next milestone (M5 — Analytics & reporting) needs to know

- **`messages.broadcast_id`** is the join key for per-campaign analytics — no new schema
  needed to report on campaign performance, it's already there on every message a
  broadcast produced.
- **`messages.group_id`** similarly distinguishes group traffic for any inbound-volume or
  per-number breakdown that wants to separate 1:1 from group activity.
- **Daily Stats rollup** (the PRD's M5 entity) is still fully greenfield — nothing from M4
  pre-computes it. `campaignProgress()` in `db/broadcasts.ts` shows the live per-campaign
  counting pattern (group by `messages.status`) M5's rollup can follow or feed from.
- **`refreshCampaignStatus()`'s lazy self-healing pattern** (recompute on read, not on
  write) is the same shape M1's Overview page and M3's list pages already use — M5's
  Analytics page can follow it rather than introducing a new "push status on every event"
  convention.

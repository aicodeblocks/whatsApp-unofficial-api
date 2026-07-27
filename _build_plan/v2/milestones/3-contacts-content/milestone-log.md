# Milestone 3 — Contacts & content: import + lists + templates + buttons

## What's new in the app

- **CSV contact import**: upload a CSV on the Contacts page — columns (phone/name/consent)
  are auto-detected by header name — and see a preview flagging invalid phone numbers and
  duplicates before anything is saved; confirm to import the valid rows into a chosen or
  new named list.
- **Contact lists / segments**: create named lists on the Contacts page, add/remove any
  contact to/from a list inline, and filter the Contacts table by list (alongside the
  existing consent filter).
- **Template library** (new "Templates" page): create, edit, and delete reusable message
  templates with `{{name}}`/`{{phone}}` placeholders, an optional media attachment (file or
  URL), and a live preview that substitutes sample values as you type.
- **Interactive buttons**: attach up to 3 buttons (quick-reply, call, or link) to a template
  or directly to a single-send message. **Important, tested live against a real phone**:
  WhatsApp's servers silently discard classic native buttons for personal (non-Business-API)
  numbers — the send succeeds with no error, but nothing is delivered. So buttons actually
  render as a clean numbered list appended to the message text (e.g. "1. Yes / 2. No / 3.
  Call support — call +1555…") — verified delivered end-to-end on a real device.
- **Template-aware sending**: the Send & Queue page's test-send form gained a "use a
  template" picker (auto-fills text/media/buttons) and its own ad-hoc buttons section,
  independent of any template.
- A basic **Templates API** (`GET/POST /api/v1/templates`, `GET/PUT/DELETE
  /api/v1/templates/:id`) so downstream systems can manage templates too — it showed up in
  the `/developers` portal automatically, no portal code changes beyond adding the tag to
  the grouping order.

## What was built

### New files
- `src/lib/csv.ts` — minimal hand-rolled CSV parser (quoted fields, escaped quotes) plus
  `detectColumns()` (header-name auto-detection for phone/name/consent, falling back to
  "column 0 = phone" if nothing matches).
- `src/db/contact-lists.ts` — `contact_lists`/`contact_list_members` CRUD, `findOrCreateList`,
  `listsForContact`, `contactIdsInList`, and `contact_imports` record-keeping (`recordImport`).
- `src/db/buttons.ts` — one polymorphic `buttons` table (`owner_type: 'template'|'message'`,
  `owner_id`) shared by templates and single-send messages, instead of two parallel tables.
  `setButtonsFor`/`getButtonsFor`, capped at 3 buttons (WhatsApp's classic limit), label
  truncated to 20 chars.
- `src/db/templates.ts` — template CRUD (`createTemplate`/`updateTemplate`/`deleteTemplate`/
  `getTemplate`/`listTemplates`), each returning its buttons; `fillPlaceholders()` substitutes
  `{{name}}` (falling back to phone if no display name) and `{{phone}}` — the only two fields
  the Contact model has.
- `src/routes/dashboard/contacts.ts` (extended) — CSV upload/preview (`POST
  /contacts/import`, stateless: valid rows round-trip through a hidden `rows_json` field
  rather than a server-side session) and confirm (`POST /contacts/import/confirm`); list CRUD
  and membership routes.
- `src/routes/dashboard/templates.ts`, `src/views/templates.ejs` — the Templates page
  (multipart form, reusing the same upload-to-`data/media/` pattern as
  `/api/v1/messages/upload`), with a vanilla-JS live preview (same embedded-data-plus-JS
  pattern the M2 developer-portal console established).
- `src/routes/api/templates.ts` — templates REST CRUD, tagged `templates`.

### Changed files
- `src/db/migrations.ts` — new tables `contact_lists`, `contact_list_members`,
  `contact_imports`, `templates` (incl. a `media_type` column — see decisions below),
  `buttons`; `messages` gained a nullable `template_id` column.
- `src/db/contacts.ts` — added `updateContactName()` (previously insert-only).
- `src/db/messages.ts` — `Message`/`NewMessage` gained `template_id`.
- `src/whatsapp/enqueue.ts` — `EnqueueInput` gained `template_id`/`buttons`; when a template
  is used, ad-hoc content on the same request is rejected (pick one or the other); buttons
  force a text send regardless of type/media; `{{placeholders}}` are filled from the
  resolved contact right before the message row is created.
- `src/whatsapp/media.ts` — `buildContent()` takes a `buttons` param; when present, renders
  the numbered-list text fallback (see decisions) instead of the normal text/media shape.
- `src/whatsapp/queue.ts` — looks up a message's buttons via `getButtonsFor('message', id)`
  and passes them into `buildContent()`.
- `src/views/contacts.ejs` — Lists panel, CSV import form + preview/confirm UI, list filter,
  per-contact list-membership pills with inline add/remove.
- `src/views/queue.ejs` — template picker + ad-hoc buttons section on the send form.
- `src/views/partials/head.ejs` — "Templates" nav flipped from `.soon` to a real link.
- `src/plugins/swagger.ts` — added the `templates` tag description.
- `src/routes/dashboard/portal.ts` (M2's developer portal) — added `templates` to
  `TAG_ORDER`/`TAG_LABELS` so the new API endpoints group correctly; this is the one small
  portal change needed (the M2 log's claim of "zero portal changes" for new tagged routes
  was only true for grouping *within* an already-listed tag, not a brand-new tag).

## Decisions made during implementation (not pre-specified)

- **Buttons render as a text fallback, not real WhatsApp buttons — confirmed by live testing,
  not assumption.** A raw `buttonsMessage` proto was built and sent via a new low-level
  `sock.relayMessage()` path (bypassing Baileys' friendly `sendMessage()`, which has no
  button support at all in this version). It was tested live against the real linked
  number: the send succeeded (a real WhatsApp message id, no error, `status: sent`), but
  **nothing was ever delivered to the device** — confirmed by the user checking their phone.
  This matches the investigation from the planning phase (WhatsApp deprecating classic
  interactive buttons for non-Business-API personal numbers). The raw-proto code was then
  **removed** (not shipped as dead/unused code) in favor of rendering buttons as a numbered
  text list appended to the message (`src/whatsapp/media.ts`'s `buildButtonsContent()`) —
  this was re-tested live and confirmed **delivered** end-to-end on a real device. Button
  metadata (type/label/payload) is still fully stored and exposed via the API/dashboard for
  any downstream system that wants to render real interactive UI itself.
- **`templates.media_type`** was added (not in the original plan) because a template with
  media needs to know *which* media type (image/document/audio/video) to build the right
  Baileys content shape — the PRD's "media reference" didn't specify this, and guessing from
  file extension seemed fragier than an explicit field. Defaults to `document`.
- **CSV import preview is stateless**, round-tripping the validated rows through a hidden
  form field (`rows_json`) between the preview and confirm steps, rather than a server-side
  session — simpler, matches the site's existing simple-form conventions (no prior
  multi-step-wizard/session-state pattern existed to follow).
- **Buttons + media are mutually exclusive** in v2, enforced both at enqueue time (buttons
  force `type: 'text'`, media fields cleared) and in `buildContent()`.

## Deviations from the PRD

- **Contact import is dashboard-only**, not exposed over the token API this milestone (the
  PRD's "Done when" for M3 is UI-focused; multipart CSV upload over the API was judged not
  worth the added surface yet).
- Buttons do not render as real native WhatsApp interactive UI (see decision above) — this
  is a deviation from the PRD's literal wording ("attach interactive buttons... quick-reply,
  call, link") forced by a real platform constraint discovered and verified during this
  milestone, not a scoping choice made in advance.

## Verification performed

- `npm run typecheck` clean throughout; `npm run build && node dist/server.js` (host, per
  the established caveat) against an **isolated copy of the DB tables only** — a mistake was
  made and caught mid-session: an earlier copy included `data/sessions/` (the live WhatsApp
  auth state), which caused a host test process to briefly attempt a second live connection
  as the same linked device before being killed within seconds. No apparent harm (the real
  container reconnected `linked` normally afterward), but this is now a documented standing
  rule for future test-data copies.
- CSV import: uploaded a 4-row test CSV (1 valid, 1 valid, 1 invalid phone, 1 duplicate) —
  preview correctly flagged the invalid and duplicate rows and skipped them; confirm
  imported exactly the 2 valid rows into a new list, with correct name/consent/list
  membership verified via the contacts API afterward.
- Templates: created via the API (name, `{{name}}` placeholder, 2 quick-reply buttons),
  confirmed it renders on the Templates page with its buttons shown.
- Dashboard pages (`/templates`, `/contacts`, `/queue`) all render (200) under an admin
  session; public routes (`/developers`, `/docs`, `/openapi.json`) unaffected (200).
- `/developers` (M2's portal) automatically listed the new `templates` endpoints once the
  tag was added to `portal.ts`'s grouping — proving the spec-driven design holds with one
  small addition (a brand-new tag needs registering; an existing tag's new routes need none).
- **Live device tests against the real container** (quiet hours briefly disabled and
  restored immediately after each test, to avoid multi-hour waits — `./data` untouched
  throughout):
  1. Plain sanity-check text send → `status: sent`, confirmed arrived.
  2. Raw native-buttons attempt → `status: sent` with a real provider id, but **confirmed
     nothing arrived on the device at all** — the finding that drove the pivot to the text
     fallback.
  3. Buttons-as-text-fallback send (to a second real phone, `919663291144`) → `status:
     delivered`, confirmed arrived as a clean, readable numbered list.
- Docker rebuilt three times over the course of this milestone (code changes, then the
  fallback pivot); the linked number reconnected `linked` cleanly every time.

## What the next milestone needs to know

- **Button metadata is real and queryable** (`getButtonsFor`/the templates API) even though
  WhatsApp delivery renders as text — M4's broadcast campaigns can reuse the exact same
  `buttons` table/helpers without re-litigating the native-vs-fallback question.
- **`fillPlaceholders()`** in `src/db/templates.ts` is the one placeholder-substitution
  implementation — reuse it rather than re-implementing `{{}}` replacement for broadcast
  content.
- **New tag checklist for the developer portal**: adding a route with a brand-new `tags`
  value requires one line each in `src/routes/dashboard/portal.ts`'s `TAG_ORDER` and
  `TAG_LABELS` — routes added under an *existing* tag need nothing.
- **Test-data isolation rule** (see decisions above): never copy `data/sessions/` when
  making an isolated host test-data directory.

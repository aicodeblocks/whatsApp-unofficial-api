# Milestone 1 — Bots & Template Rules — build log

## What's new in the app

- A new **Bots** page in the dashboard (nav link between Broadcasts and the separator). Create, edit, pause, and delete auto-reply bots.
- A bot **answers inbound 1:1 WhatsApp messages automatically** on the number(s) it's bound to — no AI, purely template-driven.
- Per bot you build a list of **rules**: each maps a trigger (keyword / contains / exact / regex, case-insensitive) to a **reply template**. Rules evaluate top-to-bottom, first match wins. One rule can be the **default case** for off-menu input.
- **One active bot per number** (enforced), an optional **business-hours** window, a **per-bot active toggle**, and a **global master switch** to turn all auto-replies off at once.
- Replies go out through the **existing anti-ban queue** — they respect pacing, warm-up, quiet hours, daily limits, and consent automatically. The bot never replies in groups, never to a STOP message, and never to a blocked contact.
- A token-authed **Bots API** (`/api/v1/bots` + `/api/v1/bots/settings`) documented in `/developers` under a new **bots** tag, so downstream apps can manage bots programmatically.

## What was built

**Schema** (`src/db/migrations.ts`, appended idempotently):
- `bots` — id, name, active, ai_enabled, persona, reshow_menu, business_hours_enabled/start/end, timestamps. (AI columns modeled now, used from M3.)
- `bot_numbers` — (bot_id, number_id) binding with `UNIQUE(number_id)` enforcing one-bot-per-number.
- `bot_rules` — bot_id, trigger_type, trigger_value, template_id, priority, is_default_case.
- `bot_reply_log` — inbound/reply message ids, contact_id, outcome, matched rule/template, reply_text, and `ai_*` columns (null until M3).

**Data layer** (`src/db/bots.ts`, new): CRUD for bots + bindings + rules (`createBot`/`getBot`/`listBots`/`updateBot`/`deleteBot`), `getActiveBotForNumber`, `numbersOwnedByOtherBot`, the global switch (`areBotsEnabled`/`setBotsEnabled`), reply-log writer (`logBotReply`), and the pure router `matchRule(bot, text)` → `{ rule, isDefault }`.

**Runtime** (`src/whatsapp/bot.ts`, new): `runBotReply(ctx)` — finds the active bot, checks business hours, matches a rule, and replies via `enqueueMessage({ template_id })`; logs every outcome. Never throws. Hooked into `src/whatsapp/inbound.ts` as `void runBotReply(...)`, gated on `!groupJid && !isStop`.

**API** (`src/routes/api/bots.ts`, new): token-authed list/get/create/update/delete + `POST /api/v1/bots/settings`. Validates number existence, one-bot-per-number conflicts, and template existence. Registered in `src/server.ts`; `bots` tag declared in `src/plugins/swagger.ts`.

**Dashboard** (`src/routes/dashboard/bots.ts` + `src/views/bots.ejs`, new): Bots page with master switch, create/edit form (name, active, business hours, number checkboxes, dynamic rule builder), and a bot list with edit/pause/delete. Number/rule selections are serialized to hidden JSON fields on submit. Nav link added in `src/views/partials/head.ejs`; route registered in `src/server.ts`.

**Settings helper** (`src/db/settings.ts`): added generic `getAppSetting`/`setAppSetting`/`getBoolSetting` for the `bots_enabled` flag.

## Decisions made during implementation (not pre-specified)

- **Bot replies to media-only inbound**: a message with no text (image/doc) matches no keyword rule, so it falls to the default-case template if one exists (else outcome `none`). Reasonable — it's off-menu input.
- **Rule form transport**: numbers and rules are posted as two JSON hidden fields (`number_ids_json`, `rules_json`) rather than repeated form keys, to avoid urlencoded array-parsing ambiguity. The dashboard requires JS (consistent with the Templates page).
- **Default-case rules need no trigger value**; the dashboard disables/clears the trigger input when "default" is checked, and both the API validator and dashboard parser drop incomplete rows.
- **Toggle endpoint** (`/bots/:id/toggle`) re-saves the whole bot with `active` flipped, reusing `updateBot` rather than adding a dedicated column mutator.
- **Business hours**: outside the window the bot stays **silent** (no after-hours template in M1 — kept simple; can be added later). Overnight windows (start > end) wrap past midnight; `start === end` means 24h.

## Verification performed

- **`npm run build`** clean (tsc).
- **Isolated end-to-end script** (`scratchpad/verify-m1.mjs`, throwaway `DATA_DIR` — never the live session): 18/18 checks — all four trigger types incl. whole-word keyword (`help` ≠ `helpful`) and exact (`1` ≠ `11`), priority/first-match, default-case fallback, `runBotReply` enqueuing the correct template with a queued job and correct log outcome (`rule`/`default_case`), and the three guards (global switch off, inactive bot, blocked recipient → outcome `none`, no send) plus one-bot-per-number enforcement.
- **HTTP smoke test** (isolated `DATA_DIR`, alt port): server boots clean, `/bots` 302→`/login` when unauthed, `/api/v1/bots` 401 without a token, and all bot paths + the `bots` tag appear in `/openapi.json`.
- Not exercised on the real linked number (that lives on the Docker container / Cloudways box) — the anti-ban send path itself is unchanged v1 code; the bot only feeds it, and that feed is verified. A live check on the real number is worth doing when convenient: message the linked number from the standing test recipient and confirm the auto-reply arrives.

## What the next milestone (M2 — AI Provider Hub) needs to know

- The bot's AI columns already exist (`bots.ai_enabled`, `bots.persona`, `bots.reshow_menu`; `bot_reply_log.ai_*`) — M2/M3 populate/consult them; no migration needed for those.
- The runtime's "no rule matched" branch in `src/whatsapp/bot.ts` currently logs outcome `none` and returns — **this is the exact insertion point for the M3 AI fallback** (when the bot has AI enabled).
- `matchRule` returning `undefined` = "no rule and no default case"; a matched default case is `{ isDefault: true }`. M3 should invoke AI when `matchRule` returns `undefined` OR (per PRD) when it would otherwise hit the default case — confirm the intended trigger point in M3 planning.
- New generic settings helpers (`getAppSetting`/`setAppSetting`/`getBoolSetting`) are available for provider config flags.

## Deviations from the PRD

None. Scope matches the M1 definition; the API shipped alongside the UI per the cross-cutting API-first requirement.

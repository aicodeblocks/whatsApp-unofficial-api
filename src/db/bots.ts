/**
 * Data layer for the v3 auto-reply bot (Milestone 1).
 *
 * A Bot is a template-driven responder bound to one or more linked numbers
 * (one active bot per number). Its rules map an inbound keyword to a reply
 * Template. `matchRule` implements the runtime routing: rules are evaluated by
 * priority ascending (first match wins), case-insensitively, with the
 * default-case rule reserved as the fallback when nothing else matches.
 *
 * The AI-related columns (ai_enabled, persona, reshow_menu) and the reply-log's
 * ai_* columns are modeled here but only exercised from v3 M3 onward.
 */
import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import { getBoolSetting, setAppSetting } from './settings.js';

/** Global master switch for all bots — when off, the runtime never replies. */
const BOTS_ENABLED_KEY = 'bots_enabled';

export function areBotsEnabled(): boolean {
  return getBoolSetting(BOTS_ENABLED_KEY, true);
}

export function setBotsEnabled(enabled: boolean): void {
  setAppSetting(BOTS_ENABLED_KEY, enabled ? '1' : '0');
}

export type TriggerType = 'keyword' | 'contains' | 'exact' | 'regex';
export const TRIGGER_TYPES: TriggerType[] = ['keyword', 'contains', 'exact', 'regex'];

export interface Bot {
  id: string;
  name: string;
  active: boolean;
  ai_enabled: boolean;
  persona: string | null;
  reshow_menu: boolean;
  business_hours_enabled: boolean;
  business_hours_start: string | null;
  business_hours_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotRule {
  id: string;
  bot_id: string;
  trigger_type: TriggerType;
  trigger_value: string;
  template_id: string;
  priority: number;
  is_default_case: boolean;
  created_at: string;
  updated_at: string;
}

export interface BotWithDetail extends Bot {
  number_ids: string[];
  rules: BotRule[];
}

interface BotRow {
  id: string;
  name: string;
  active: number;
  ai_enabled: number;
  persona: string | null;
  reshow_menu: number;
  business_hours_enabled: number;
  business_hours_start: string | null;
  business_hours_end: string | null;
  created_at: string;
  updated_at: string;
}

interface BotRuleRow {
  id: string;
  bot_id: string;
  trigger_type: string;
  trigger_value: string;
  template_id: string;
  priority: number;
  is_default_case: number;
  created_at: string;
  updated_at: string;
}

function toBot(r: BotRow): Bot {
  return {
    id: r.id,
    name: r.name,
    active: !!r.active,
    ai_enabled: !!r.ai_enabled,
    persona: r.persona,
    reshow_menu: !!r.reshow_menu,
    business_hours_enabled: !!r.business_hours_enabled,
    business_hours_start: r.business_hours_start,
    business_hours_end: r.business_hours_end,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function toRule(r: BotRuleRow): BotRule {
  return {
    id: r.id,
    bot_id: r.bot_id,
    trigger_type: (TRIGGER_TYPES.includes(r.trigger_type as TriggerType) ? r.trigger_type : 'keyword') as TriggerType,
    trigger_value: r.trigger_value,
    template_id: r.template_id,
    priority: r.priority,
    is_default_case: !!r.is_default_case,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---- Prepared statements ---------------------------------------------------

const insertBotStmt = db.prepare(`
  INSERT INTO bots (id, name, active, ai_enabled, persona, reshow_menu,
                    business_hours_enabled, business_hours_start, business_hours_end, created_at, updated_at)
  VALUES (@id, @name, @active, @ai_enabled, @persona, @reshow_menu,
          @business_hours_enabled, @business_hours_start, @business_hours_end, @now, @now)
`);
const getBotStmt = db.prepare('SELECT * FROM bots WHERE id = ?');
const listBotsStmt = db.prepare('SELECT * FROM bots ORDER BY created_at DESC');
const updateBotStmt = db.prepare(`
  UPDATE bots
     SET name = @name, active = @active, ai_enabled = @ai_enabled, persona = @persona,
         reshow_menu = @reshow_menu, business_hours_enabled = @business_hours_enabled,
         business_hours_start = @business_hours_start, business_hours_end = @business_hours_end,
         updated_at = @now
   WHERE id = @id
`);
const deleteBotStmt = db.prepare('DELETE FROM bots WHERE id = ?');

const listNumberIdsStmt = db.prepare('SELECT number_id FROM bot_numbers WHERE bot_id = ? ORDER BY created_at');
const clearNumbersStmt = db.prepare('DELETE FROM bot_numbers WHERE bot_id = ?');
const insertNumberStmt = db.prepare('INSERT OR IGNORE INTO bot_numbers (bot_id, number_id, created_at) VALUES (?, ?, ?)');
const botIdForNumberStmt = db.prepare('SELECT bot_id FROM bot_numbers WHERE number_id = ?');

const listRulesStmt = db.prepare('SELECT * FROM bot_rules WHERE bot_id = ? ORDER BY priority ASC, created_at ASC');
const clearRulesStmt = db.prepare('DELETE FROM bot_rules WHERE bot_id = ?');
const insertRuleStmt = db.prepare(`
  INSERT INTO bot_rules (id, bot_id, trigger_type, trigger_value, template_id, priority, is_default_case, created_at, updated_at)
  VALUES (@id, @bot_id, @trigger_type, @trigger_value, @template_id, @priority, @is_default_case, @now, @now)
`);

const insertLogStmt = db.prepare(`
  INSERT INTO bot_reply_log (id, bot_id, number_id, contact_id, inbound_message_id, reply_message_id,
                             inbound_text, outcome, matched_rule_id, matched_template_id, reply_text,
                             ai_provider, ai_model, ai_tokens, ai_cost, created_at)
  VALUES (@id, @bot_id, @number_id, @contact_id, @inbound_message_id, @reply_message_id,
          @inbound_text, @outcome, @matched_rule_id, @matched_template_id, @reply_text,
          @ai_provider, @ai_model, @ai_tokens, @ai_cost, @now)
`);

// ---- Inputs ----------------------------------------------------------------

export interface BotRuleInput {
  trigger_type: TriggerType;
  trigger_value: string;
  template_id: string;
  is_default_case?: boolean;
}

export interface BotInput {
  name: string;
  active?: boolean;
  ai_enabled?: boolean;
  persona?: string | null;
  reshow_menu?: boolean;
  business_hours_enabled?: boolean;
  business_hours_start?: string | null;
  business_hours_end?: string | null;
  number_ids?: string[];
  rules?: BotRuleInput[];
}

// ---- Bindings / rules writers (shared by create + update) ------------------

/**
 * Rebinds a bot's numbers. Because bot_numbers.number_id is UNIQUE, a number
 * already answered by another bot is skipped (INSERT OR IGNORE) and reported so
 * the caller can surface a conflict rather than silently stealing the number.
 */
function setNumbers(botId: string, numberIds: string[]): { bound: string[]; conflicts: string[] } {
  clearNumbersStmt.run(botId);
  const now = new Date().toISOString();
  const bound: string[] = [];
  const conflicts: string[] = [];
  for (const numberId of numberIds) {
    const owner = (botIdForNumberStmt.get(numberId) as { bot_id: string } | undefined)?.bot_id;
    if (owner && owner !== botId) {
      conflicts.push(numberId);
      continue;
    }
    insertNumberStmt.run(botId, numberId, now);
    bound.push(numberId);
  }
  return { bound, conflicts };
}

function setRules(botId: string, rules: BotRuleInput[]): void {
  clearRulesStmt.run(botId);
  const now = new Date().toISOString();
  rules.forEach((rule, index) => {
    insertRuleStmt.run({
      id: randomUUID(),
      bot_id: botId,
      trigger_type: TRIGGER_TYPES.includes(rule.trigger_type) ? rule.trigger_type : 'keyword',
      trigger_value: rule.trigger_value ?? '',
      template_id: rule.template_id,
      priority: index,
      is_default_case: rule.is_default_case ? 1 : 0,
      now,
    });
  });
}

// ---- Public API ------------------------------------------------------------

export function createBot(input: BotInput): BotWithDetail {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertBotStmt.run({
    id,
    name: input.name,
    active: input.active === false ? 0 : 1,
    ai_enabled: input.ai_enabled ? 1 : 0,
    persona: input.persona ?? null,
    reshow_menu: input.reshow_menu ? 1 : 0,
    business_hours_enabled: input.business_hours_enabled ? 1 : 0,
    business_hours_start: input.business_hours_start ?? null,
    business_hours_end: input.business_hours_end ?? null,
    now,
  });
  if (input.number_ids) setNumbers(id, input.number_ids);
  if (input.rules) setRules(id, input.rules);
  return getBot(id)!;
}

export function getBot(id: string): BotWithDetail | undefined {
  const row = getBotStmt.get(id) as BotRow | undefined;
  if (!row) return undefined;
  const number_ids = (listNumberIdsStmt.all(id) as Array<{ number_id: string }>).map((r) => r.number_id);
  const rules = (listRulesStmt.all(id) as BotRuleRow[]).map(toRule);
  return { ...toBot(row), number_ids, rules };
}

export function listBots(): BotWithDetail[] {
  const rows = listBotsStmt.all() as BotRow[];
  return rows.map((row) => {
    const number_ids = (listNumberIdsStmt.all(row.id) as Array<{ number_id: string }>).map((r) => r.number_id);
    const rules = (listRulesStmt.all(row.id) as BotRuleRow[]).map(toRule);
    return { ...toBot(row), number_ids, rules };
  });
}

export function updateBot(id: string, input: BotInput): BotWithDetail | undefined {
  const existing = getBotStmt.get(id) as BotRow | undefined;
  if (!existing) return undefined;
  updateBotStmt.run({
    id,
    name: input.name,
    active: input.active === false ? 0 : 1,
    ai_enabled: input.ai_enabled ? 1 : 0,
    persona: input.persona ?? null,
    reshow_menu: input.reshow_menu ? 1 : 0,
    business_hours_enabled: input.business_hours_enabled ? 1 : 0,
    business_hours_start: input.business_hours_start ?? null,
    business_hours_end: input.business_hours_end ?? null,
    now: new Date().toISOString(),
  });
  if (input.number_ids !== undefined) setNumbers(id, input.number_ids);
  if (input.rules !== undefined) setRules(id, input.rules);
  return getBot(id);
}

export function deleteBot(id: string): boolean {
  clearNumbersStmt.run(id);
  clearRulesStmt.run(id);
  return deleteBotStmt.run(id).changes > 0;
}

/** The active bot bound to a number, or undefined if none (or bot inactive). */
export function getActiveBotForNumber(numberId: string): BotWithDetail | undefined {
  const owner = (botIdForNumberStmt.get(numberId) as { bot_id: string } | undefined)?.bot_id;
  if (!owner) return undefined;
  const bot = getBot(owner);
  if (!bot || !bot.active) return undefined;
  return bot;
}

/**
 * Returns which numbers of the given set are already bound to a *different*
 * bot — used by the dashboard/API to warn about the "one bot per number" rule
 * before a save silently drops them.
 */
export function numbersOwnedByOtherBot(botId: string | null, numberIds: string[]): string[] {
  const conflicts: string[] = [];
  for (const numberId of numberIds) {
    const owner = (botIdForNumberStmt.get(numberId) as { bot_id: string } | undefined)?.bot_id;
    if (owner && owner !== botId) conflicts.push(numberId);
  }
  return conflicts;
}

// ---- Rule matching (the runtime's routing decision) ------------------------

export interface RuleMatch {
  rule: BotRule;
  isDefault: boolean;
}

/**
 * Picks the rule that answers `text` for this bot: the first non-default rule
 * (by priority) whose trigger matches case-insensitively, else the default-case
 * rule if one exists. Returns undefined when nothing matches and there is no
 * default case (the runtime then stays silent, or — from M3 — asks the AI).
 */
export function matchRule(bot: BotWithDetail, text: string): RuleMatch | undefined {
  const haystack = (text ?? '').trim().toLowerCase();
  const rules = [...bot.rules].sort((a, b) => a.priority - b.priority);
  let defaultRule: BotRule | undefined;

  for (const rule of rules) {
    if (rule.is_default_case) {
      defaultRule ??= rule;
      continue;
    }
    if (triggerMatches(rule, haystack)) return { rule, isDefault: false };
  }
  if (defaultRule) return { rule: defaultRule, isDefault: true };
  return undefined;
}

function triggerMatches(rule: BotRule, haystackLower: string): boolean {
  const needle = (rule.trigger_value ?? '').trim().toLowerCase();
  if (!needle) return false;
  switch (rule.trigger_type) {
    case 'exact':
      return haystackLower === needle;
    case 'contains':
      return haystackLower.includes(needle);
    case 'regex':
      try {
        return new RegExp(rule.trigger_value, 'i').test(haystackLower);
      } catch {
        return false; // a malformed pattern never matches (and never throws)
      }
    case 'keyword':
    default:
      // Whole-word match: "help" matches "i need help" but not "helpful".
      return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(haystackLower);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Reply log -------------------------------------------------------------

export type BotOutcome = 'rule' | 'default_case' | 'ai' | 'none';

export interface BotLogInput {
  bot_id: string;
  number_id: string;
  contact_id?: string | null;
  inbound_message_id?: string | null;
  reply_message_id?: string | null;
  inbound_text?: string | null;
  outcome: BotOutcome;
  matched_rule_id?: string | null;
  matched_template_id?: string | null;
  reply_text?: string | null;
  ai_provider?: string | null;
  ai_model?: string | null;
  ai_tokens?: number | null;
  ai_cost?: number | null;
}

export function logBotReply(input: BotLogInput): void {
  insertLogStmt.run({
    id: randomUUID(),
    bot_id: input.bot_id,
    number_id: input.number_id,
    contact_id: input.contact_id ?? null,
    inbound_message_id: input.inbound_message_id ?? null,
    reply_message_id: input.reply_message_id ?? null,
    inbound_text: input.inbound_text ?? null,
    outcome: input.outcome,
    matched_rule_id: input.matched_rule_id ?? null,
    matched_template_id: input.matched_template_id ?? null,
    reply_text: input.reply_text ?? null,
    ai_provider: input.ai_provider ?? null,
    ai_model: input.ai_model ?? null,
    ai_tokens: input.ai_tokens ?? null,
    ai_cost: input.ai_cost ?? null,
    now: new Date().toISOString(),
  });
}

/**
 * v3 Milestone 1 — the auto-reply bot runtime.
 *
 * Called from the inbound path (handleInbound) for **direct (1:1) messages
 * only**. It finds the active bot bound to the receiving number, matches the
 * inbound text against the bot's rules, and — if a rule (or the default-case
 * rule) matches — sends the mapped template back through the existing anti-ban
 * send queue (enqueueMessage), which already enforces consent, pacing, and
 * placeholder-fill. Every considered message is written to the Bot Reply Log.
 *
 * Deliberately conservative to avoid ban risk and reply loops: never runs when
 * the global switch or the bot is off, never in group chats, never for
 * opt-out/STOP messages, and lets enqueueMessage reject blocked recipients.
 *
 * AI fallback (when no rule matches and the bot has AI enabled) is intentionally
 * NOT here yet — that arrives in v3 M3. For now an unmatched message with no
 * default-case rule is logged as outcome 'none' and gets no reply.
 */
import { config } from '../config.js';
import {
  areBotsEnabled,
  getActiveBotForNumber,
  logBotReply,
  matchRule,
  type BotWithDetail,
} from '../db/bots.js';
import { EnqueueError, enqueueMessage } from './enqueue.js';

export interface BotReplyContext {
  numberId: string;
  fromPhone: string;
  contactId: string | null;
  inboundMessageId: string | null;
  text: string | null;
}

/**
 * Consider one inbound 1:1 message for an auto-reply. Never throws — any
 * failure (no bot, no match, a rejected send) is swallowed/logged so inbound
 * capture is never disrupted by the bot.
 */
export async function runBotReply(ctx: BotReplyContext): Promise<void> {
  try {
    if (!areBotsEnabled()) return;

    const bot = getActiveBotForNumber(ctx.numberId);
    if (!bot) return;

    if (!withinBusinessHours(bot)) return;

    const text = ctx.text ?? '';
    const match = matchRule(bot, text);

    if (!match) {
      // No rule and no default case. (v3 M3 will hand this to the AI fallback
      // when the bot has AI enabled.) Log it so M5 can show the miss.
      logBotReply({
        bot_id: bot.id,
        number_id: ctx.numberId,
        contact_id: ctx.contactId,
        inbound_message_id: ctx.inboundMessageId,
        inbound_text: text || null,
        outcome: 'none',
      });
      return;
    }

    try {
      const reply = enqueueMessage({
        number_id: ctx.numberId,
        to: ctx.fromPhone,
        type: 'text',
        template_id: match.rule.template_id,
      });
      logBotReply({
        bot_id: bot.id,
        number_id: ctx.numberId,
        contact_id: ctx.contactId,
        inbound_message_id: ctx.inboundMessageId,
        reply_message_id: reply.id,
        inbound_text: text || null,
        outcome: match.isDefault ? 'default_case' : 'rule',
        matched_rule_id: match.rule.id,
        matched_template_id: match.rule.template_id,
        reply_text: reply.content ?? null,
      });
    } catch (err) {
      // enqueueMessage rejects blocked recipients (consent withdrawn), unknown
      // templates, etc. Log the miss rather than replying, and never surface it.
      if (err instanceof EnqueueError) {
        logBotReply({
          bot_id: bot.id,
          number_id: ctx.numberId,
          contact_id: ctx.contactId,
          inbound_message_id: ctx.inboundMessageId,
          inbound_text: text || null,
          outcome: 'none',
          matched_rule_id: match.rule.id,
          matched_template_id: match.rule.template_id,
          reply_text: `[not sent: ${err.code}]`,
        });
        return;
      }
      throw err;
    }
  } catch {
    // Absolute last resort: a bot failure must never break inbound capture.
  }
}

/**
 * True if the bot may reply right now. When business hours are disabled the bot
 * is always active. Otherwise the current time in the display timezone must
 * fall inside [start, end); an overnight window (start > end, e.g. 22:00–06:00)
 * is treated as wrapping past midnight.
 */
function withinBusinessHours(bot: BotWithDetail): boolean {
  if (!bot.business_hours_enabled) return true;
  const start = parseHm(bot.business_hours_start);
  const end = parseHm(bot.business_hours_end);
  if (start === null || end === null) return true; // misconfigured → don't block

  const now = minutesOfDayInTz(config.displayTz);
  if (start === end) return true; // 24h window
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // wraps past midnight
}

/** "HH:MM" → minutes since midnight, or null if unparseable. */
function parseHm(hm: string | null): number | null {
  if (!hm) return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current minutes-since-midnight in the given timezone. */
function minutesOfDayInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + min;
}

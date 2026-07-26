/**
 * The anti-ban send queue worker.
 *
 * A single interval loop drains due jobs. For each eligible number it releases
 * at most one message per tick, applying: quiet-hours holds, per-number daily
 * limits (with warm-up ramp), a randomized human cooldown between sends, and a
 * typing-indicator simulation before the message actually goes out. Delivery
 * status afterwards is tracked by the manager's provider-status listener.
 */
import {
  advanceMessageStatus,
  deferJob,
  dueWaitingJobs,
  failJob,
  getMessage,
  markMessageFailed,
  markMessageSent,
  rescheduleJob,
  resetStuckJobs,
  setJobAppliedDelay,
  setJobState,
  type QueuedJob,
} from '../db/messages.js';
import { getContact, markContacted } from '../db/contacts.js';
import {
  dailyCountFor,
  ensureWarmupStarted,
  getNumber,
  recordDailySend,
} from '../db/numbers.js';
import { buildContent } from './media.js';
import { whatsappManager, phoneToJid } from './manager.js';
import { emitMessageStatus } from './webhooks.js';
import {
  dailyLimitFor,
  pacing,
  quietHoldUntil,
  randomSendDelayMs,
  todayStr,
  typingDurationMs,
} from './pacing.js';

/** In-memory earliest-next-send time per number (enforces the human cooldown). */
const cooldownUntil = new Map<string, number>();

let timer: NodeJS.Timeout | null = null;
let ticking = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the worker. Recovers any jobs stranded mid-send by a restart. */
export function startQueue(): void {
  resetStuckJobs();
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, pacing.tickMs);
}

export function stopQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (ticking) return; // never overlap ticks
  ticking = true;
  try {
    const jobs = dueWaitingJobs();
    const handledNumbers = new Set<string>();
    for (const job of jobs) {
      // One release per number per tick keeps sends serialized and paced.
      if (handledNumbers.has(job.number_id)) continue;
      handledNumbers.add(job.number_id);
      await processJob(job);
    }
  } catch {
    /* a bad tick must not kill the interval */
  } finally {
    ticking = false;
  }
}

async function processJob(job: QueuedJob): Promise<void> {
  const now = new Date();
  const number = getNumber(job.number_id);
  const message = getMessage(job.message_id);

  // The number or message vanished (e.g. unlinked) — drop the job.
  if (!number || !message) {
    setJobState(job.id, 'failed');
    return;
  }

  // Paused queue: hold without consuming an attempt.
  if (number.queue_paused) {
    return holdJob(job, now, pacing.retryBackoffMs, 'queue_paused');
  }

  // Quiet hours: release at the next allowed window.
  const holdUntil = quietHoldUntil(now);
  if (holdUntil) {
    return deferJob(job.id, holdUntil.toISOString(), 'quiet_hours');
  }

  // Number not connected: wait for reconnect (no attempt consumed).
  if (!whatsappManager.isLinked(number.id)) {
    return holdJob(job, now, pacing.retryBackoffMs, 'number_not_linked');
  }

  // Daily limit / warm-up ceiling reached: defer and re-check later.
  const today = todayStr(now);
  const limit = dailyLimitFor(number.warmup_started_at, now);
  if (dailyCountFor(number, today) >= limit) {
    return holdJob(job, now, 30 * 60_000, 'daily_limit_reached');
  }

  // Per-number cooldown between consecutive sends.
  const cd = cooldownUntil.get(number.id) ?? 0;
  if (now.getTime() < cd) {
    return holdJob(job, now, cd - now.getTime(), 'cooldown');
  }

  await releaseSend(job, message.id, number.id);
}

/** Reschedule a job a short while out without counting it as a failed attempt. */
function holdJob(job: QueuedJob, now: Date, ms: number, reason: string): void {
  deferJob(job.id, new Date(now.getTime() + ms).toISOString(), reason);
}

async function releaseSend(job: QueuedJob, messageId: string, numberId: string): Promise<void> {
  setJobState(job.id, 'processing');
  const message = getMessage(messageId)!;
  const contact = getContact(message.contact_id);
  if (!contact) {
    setJobState(job.id, 'failed');
    markMessageFailed(messageId, 'contact_missing');
    return;
  }

  const jid = phoneToJid(contact.phone_number);
  const bodyLen = (message.content ?? message.caption ?? '').length || 8;
  const typing = typingDurationMs(bodyLen);
  setJobAppliedDelay(job.id, typing);

  try {
    // Human typing simulation, then send.
    await whatsappManager.sendPresence(numberId, jid, 'composing');
    await sleep(typing);
    await whatsappManager.sendPresence(numberId, jid, 'paused');

    const content = await buildContent(message);
    const providerId = await whatsappManager.sendMessage(numberId, jid, content);

    markMessageSent(messageId, providerId);
    advanceMessageStatus(messageId, 'sent');
    emitMessageStatus(messageId, 'sent');
    markContacted(contact.id);
    const iso = new Date().toISOString();
    ensureWarmupStarted(numberId, iso);
    recordDailySend(numberId, todayStr());
    setJobState(job.id, 'done');

    // Arm the cooldown so the next send on this number waits a human delay.
    cooldownUntil.set(numberId, Date.now() + randomSendDelayMs());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    if (attempts >= pacing.maxAttempts) {
      failJob(job.id, reason);
      markMessageFailed(messageId, reason);
      emitMessageStatus(messageId, 'failed');
    } else {
      const backoff = pacing.retryBackoffMs * attempts;
      rescheduleJob(job.id, new Date(Date.now() + backoff).toISOString(), reason);
    }
  }
}

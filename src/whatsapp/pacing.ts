/**
 * The anti-ban pacing engine. Pure, side-effect-free helpers that decide how
 * long to wait, how long to "type", how many messages a number may send today
 * (with a warm-up ramp), and whether we are inside configured quiet hours.
 *
 * All parameters are env-configurable with human-friendly, conservative
 * defaults so a fresh install behaves safely without any tuning.
 */

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const pacing = {
  /** Interval the queue worker wakes on to look for due jobs. */
  tickMs: num(process.env.QUEUE_TICK_MS, 2000),

  /** Randomized human gap between two consecutive sends on the same number. */
  sendDelayMinMs: num(process.env.SEND_DELAY_MIN_MS, 6000),
  sendDelayMaxMs: num(process.env.SEND_DELAY_MAX_MS, 25000),

  /** Typing-indicator duration: base + per-character, capped. */
  typingBaseMs: num(process.env.TYPING_BASE_MS, 1200),
  typingPerCharMs: num(process.env.TYPING_PER_CHAR_MS, 45),
  typingMaxMs: num(process.env.TYPING_MAX_MS, 9000),

  /** Full daily send ceiling once a number is fully warmed up. */
  dailyLimitMax: num(process.env.DAILY_LIMIT_MAX, 250),

  /** Retry policy for transient send failures. */
  maxAttempts: num(process.env.SEND_MAX_ATTEMPTS, 3),
  retryBackoffMs: num(process.env.SEND_RETRY_BACKOFF_MS, 30000),

  /** Quiet hours: no sends between start and end (local, or QUIET_TZ). */
  quietEnabled: (process.env.QUIET_HOURS_ENABLED ?? 'true') !== 'false',
  quietStartHour: num(process.env.QUIET_START_HOUR, 21),
  quietEndHour: num(process.env.QUIET_END_HOUR, 8),
  quietTz: process.env.QUIET_TZ || undefined,
} as const;

/**
 * Warm-up ramp: daily allowance for each day since the number's first send.
 * Day 0 (freshly linked) starts small and climbs; after the ramp, dailyLimitMax.
 */
const WARMUP_RAMP: number[] = (process.env.WARMUP_RAMP ?? '20,40,80,120,160,200')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** A uniformly random integer in [min, max]. */
export function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** The randomized human-like delay to apply before releasing the next send. */
export function randomSendDelayMs(): number {
  return randomBetween(pacing.sendDelayMinMs, pacing.sendDelayMaxMs);
}

/** How long to show the typing indicator for a message of the given length. */
export function typingDurationMs(textLength: number): number {
  const raw = pacing.typingBaseMs + Math.max(0, textLength) * pacing.typingPerCharMs;
  return Math.min(raw, pacing.typingMaxMs);
}

/** YYYY-MM-DD for "today" in the quiet-hours timezone (or server local). */
export function todayStr(now: Date = new Date()): string {
  return localParts(now).date;
}

/**
 * Whole days elapsed since the number's warm-up started (its first-ever send).
 * If warm-up hasn't started, the number is on day 0.
 */
function warmupDayIndex(warmupStartedAt: string | null, now: Date): number {
  if (!warmupStartedAt) return 0;
  const start = Date.parse(warmupStartedAt);
  if (!Number.isFinite(start)) return 0;
  const days = Math.floor((now.getTime() - start) / 86_400_000);
  return Math.max(0, days);
}

/** The number of messages this number is allowed to send today. */
export function dailyLimitFor(warmupStartedAt: string | null, now: Date = new Date()): number {
  const day = warmupDayIndex(warmupStartedAt, now);
  if (day < WARMUP_RAMP.length) return Math.min(WARMUP_RAMP[day], pacing.dailyLimitMax);
  return pacing.dailyLimitMax;
}

/** Local hour/minute/date in the configured timezone (falls back to server local). */
function localParts(now: Date): { hour: number; minute: number; date: string } {
  if (!pacing.quietTz) {
    return {
      hour: now.getHours(),
      minute: now.getMinutes(),
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    };
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: pacing.quietTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** True if `now` is inside the configured quiet-hours window. */
export function isQuietHours(now: Date = new Date()): boolean {
  if (!pacing.quietEnabled) return false;
  const { hour } = localParts(now);
  const { quietStartHour: s, quietEndHour: e } = pacing;
  if (s === e) return false;
  // Overnight window (e.g. 21 → 8) wraps past midnight.
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

/**
 * When quiet hours are active, the Date at which sending may resume (the next
 * quiet-end boundary), plus a small random jitter so held messages don't all
 * fire at the same instant. Returns null if not currently in quiet hours.
 */
export function quietHoldUntil(now: Date = new Date()): Date | null {
  if (!isQuietHours(now)) return null;
  const { hour, minute } = localParts(now);
  const e = pacing.quietEndHour;
  // Hours remaining until the local hour reaches `e` (wrapping past midnight).
  let hoursUntil = (e - hour + 24) % 24;
  if (hoursUntil === 0) hoursUntil = 24;
  const msUntil = hoursUntil * 3_600_000 - minute * 60_000;
  const jitter = randomBetween(0, 5 * 60_000);
  return new Date(now.getTime() + msUntil + jitter);
}

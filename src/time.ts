import { config } from './config.js';

/**
 * Format a stored UTC ISO-8601 timestamp as an ISO-8601 string **with the
 * offset of the configured display timezone** (e.g. 2026-07-26T21:01:05+05:30).
 * Returns null for null/invalid input. Stored timestamps stay UTC; this is only
 * for the extra *_local fields exposed to clients.
 */
export function isoInTz(iso: string | null | undefined, tz: string = config.displayTz): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset(d, tz)}`;
}

/** The "+HH:MM" / "-HH:MM" UTC offset of `tz` at the given instant. */
function offset(d: Date, tz: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value; // "GMT+05:30" or "GMT"
  const m = name?.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '+00:00';
}

/** Compact human-readable local time "YYYY-MM-DD HH:MM:SS" for the dashboard. */
export function humanInTz(iso: string | null | undefined, tz: string = config.displayTz): string {
  const s = isoInTz(iso, tz);
  return s ? s.slice(0, 19).replace('T', ' ') : '—';
}

/**
 * The calendar-day key ("YYYY-MM-DD") a UTC instant falls on in the display
 * timezone — used to bucket rows into day-granularity analytics without
 * needing exact UTC day-boundary math (see `dayKeysBetween`).
 */
export function dateKeyInTz(iso: string, tz: string = config.displayTz): string {
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's calendar-day key in the display timezone. */
export function todayKeyInTz(tz: string = config.displayTz): string {
  return dateKeyInTz(new Date().toISOString(), tz);
}

/** Every "YYYY-MM-DD" key from `from` to `to` inclusive (both are date keys). */
export function dayKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return out;
}

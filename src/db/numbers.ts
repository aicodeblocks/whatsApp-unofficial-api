import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type NumberStatus = 'connecting' | 'linked' | 'disconnected' | 'flagged';
/** Live anti-ban health signal, independent of the connection status. */
export type HealthStatus = 'healthy' | 'at_risk' | 'flagged';

export interface WhatsAppNumber {
  id: string;
  label: string;
  phone_number: string | null;
  status: NumberStatus;
  created_at: string;
  linked_at: string | null;
  // Milestone 3 — anti-ban / warm-up state.
  warmup_started_at: string | null;
  daily_sent_count: number;
  daily_count_date: string | null;
  queue_paused: number;
  // Milestone 5 — health monitoring & cool-off.
  health_status: HealthStatus;
  /** While in the future, the number is resting (held out of use) after a flag. */
  cooloff_until: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO whatsapp_numbers (id, label, status, created_at)
  VALUES (@id, @label, 'connecting', @created_at)
`);
const listStmt = db.prepare('SELECT * FROM whatsapp_numbers ORDER BY created_at ASC');
const getStmt = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?');
const setStatusStmt = db.prepare('UPDATE whatsapp_numbers SET status = ? WHERE id = ?');
const setLinkedStmt = db.prepare(
  "UPDATE whatsapp_numbers SET status = 'linked', phone_number = ?, linked_at = ? WHERE id = ?",
);
const deleteStmt = db.prepare('DELETE FROM whatsapp_numbers WHERE id = ?');

export function createNumber(label: string): WhatsAppNumber {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  insertStmt.run({ id, label, created_at });
  return getNumber(id)!;
}

export function listNumbers(): WhatsAppNumber[] {
  return listStmt.all() as WhatsAppNumber[];
}

export function getNumber(id: string): WhatsAppNumber | undefined {
  return getStmt.get(id) as WhatsAppNumber | undefined;
}

export function setNumberStatus(id: string, status: NumberStatus): void {
  setStatusStmt.run(status, id);
}

export function setNumberLinked(id: string, phone: string | null): void {
  setLinkedStmt.run(phone, new Date().toISOString(), id);
}

export function deleteNumber(id: string): void {
  deleteStmt.run(id);
}

// --- Milestone 3: anti-ban / warm-up / queue-pause helpers ---

const setPausedStmt = db.prepare('UPDATE whatsapp_numbers SET queue_paused = ? WHERE id = ?');
const setWarmupStartedStmt = db.prepare(
  'UPDATE whatsapp_numbers SET warmup_started_at = ? WHERE id = ? AND warmup_started_at IS NULL',
);
const resetDailyStmt = db.prepare(
  'UPDATE whatsapp_numbers SET daily_sent_count = 0, daily_count_date = ? WHERE id = ?',
);
const bumpDailyStmt = db.prepare(
  'UPDATE whatsapp_numbers SET daily_sent_count = daily_sent_count + 1 WHERE id = ?',
);

/** Pause or resume a number's outbound queue. */
export function setQueuePaused(id: string, paused: boolean): void {
  setPausedStmt.run(paused ? 1 : 0, id);
}

/** Record the warm-up start date on first-ever send (no-op afterwards). */
export function ensureWarmupStarted(id: string, dateISO: string): void {
  setWarmupStartedStmt.run(dateISO, id);
}

/**
 * Increment today's send count, rolling it over to 0 first when the stored
 * day (YYYY-MM-DD) differs from `today`. Returns the count after incrementing.
 */
export function recordDailySend(id: string, today: string): number {
  const row = getNumber(id);
  if (!row) return 0;
  if (row.daily_count_date !== today) resetDailyStmt.run(today, id);
  bumpDailyStmt.run(id);
  return (row.daily_count_date === today ? row.daily_sent_count : 0) + 1;
}

/** How many sends have already gone out for `today` (0 if the day rolled over). */
export function dailyCountFor(row: WhatsAppNumber, today: string): number {
  return row.daily_count_date === today ? row.daily_sent_count : 0;
}

// --- Milestone 5: health status & cool-off ---

const setHealthStmt = db.prepare('UPDATE whatsapp_numbers SET health_status = ? WHERE id = ?');
const setCooloffStmt = db.prepare('UPDATE whatsapp_numbers SET cooloff_until = ? WHERE id = ?');

/** Set the live health signal (healthy | at_risk | flagged). */
export function setHealthStatus(id: string, status: HealthStatus): void {
  setHealthStmt.run(status, id);
}

/** Put the number into (or, with null, out of) a cool-off rest period. */
export function setCooloffUntil(id: string, untilISO: string | null): void {
  setCooloffStmt.run(untilISO, id);
}

/** True if the number is currently resting in a cool-off window. */
export function inCooloff(row: WhatsAppNumber, now: Date = new Date()): boolean {
  return !!row.cooloff_until && Date.parse(row.cooloff_until) > now.getTime();
}

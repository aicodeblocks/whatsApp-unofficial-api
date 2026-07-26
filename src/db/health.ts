import { randomUUID } from 'node:crypto';
import { db } from './index.js';

/**
 * The per-number health/feedback timeline (Milestone 5). Each notable event is
 * stored with a JSON snapshot of the surrounding activity so you can review
 * what led up to a flag, and — because WhatsApp never tells you why it banned a
 * number — keep the best available evidence.
 */

export type HealthEventType =
  | 'disconnect' // unexpected transient connection drop
  | 'relogin' // WhatsApp invalidated the session (logged out — a strong danger sign)
  | 'delivery_drop' // outbound messages stopped reaching delivered/read
  | 'failure_spike' // a burst of send failures
  | 'at_risk' // number trended into the at-risk state
  | 'cooloff' // number placed into a resting cool-off period
  | 'flagged' // number considered flagged / banned
  | 'recovered' // number returned to healthy
  | 'warmup_change'; // warm-up stage advanced (informational)

export type Severity = 'info' | 'warning' | 'critical';

export interface HealthEvent {
  id: string;
  number_id: string;
  event_type: HealthEventType;
  severity: Severity;
  /** JSON string: recent send rate, volume, failure ratio, timing, etc. */
  snapshot: string | null;
  notes: string | null;
  created_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO health_events (id, number_id, event_type, severity, snapshot, notes, created_at)
  VALUES (@id, @number_id, @event_type, @severity, @snapshot, @notes, @created_at)
`);
const listForNumberStmt = db.prepare(
  'SELECT * FROM health_events WHERE number_id = ? ORDER BY created_at DESC LIMIT ?',
);
const listAllStmt = db.prepare('SELECT * FROM health_events ORDER BY created_at DESC LIMIT ?');
const countSinceStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM health_events WHERE number_id = ? AND event_type = ? AND created_at >= ?',
);

export interface NewHealthEvent {
  number_id: string;
  event_type: HealthEventType;
  severity?: Severity;
  snapshot?: unknown;
  notes?: string | null;
}

export function insertHealthEvent(e: NewHealthEvent): HealthEvent {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  insertStmt.run({
    id,
    number_id: e.number_id,
    event_type: e.event_type,
    severity: e.severity ?? 'info',
    snapshot: e.snapshot == null ? null : JSON.stringify(e.snapshot),
    notes: e.notes ?? null,
    created_at,
  });
  return { id, number_id: e.number_id, event_type: e.event_type, severity: e.severity ?? 'info', snapshot: e.snapshot == null ? null : JSON.stringify(e.snapshot), notes: e.notes ?? null, created_at };
}

export function listHealthEvents(numberId: string | undefined, limit = 50): HealthEvent[] {
  return (numberId ? listForNumberStmt.all(numberId, limit) : listAllStmt.all(limit)) as HealthEvent[];
}

/** How many events of a type this number logged since a cutoff ISO time. */
export function countEventsSince(numberId: string, type: HealthEventType, sinceISO: string): number {
  return (countSinceStmt.get(numberId, type, sinceISO) as { n: number }).n;
}

/**
 * Build an activity snapshot for a number over a trailing window: outbound
 * volume, how many were sent vs failed vs delivered/read, the failure ratio,
 * and the timestamp of the most recent send. Used both to decide health and to
 * attach evidence to a health event.
 */
export interface ActivitySnapshot {
  window_minutes: number;
  outbound_total: number;
  sent: number;
  delivered_or_read: number;
  failed: number;
  failure_ratio: number;
  last_send_at: string | null;
}

const activityStmt = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    MAX(created_at) AS last_at
  FROM messages
  WHERE number_id = @number_id AND direction = 'outbound' AND created_at >= @since
`);

export function activitySnapshot(numberId: string, windowMinutes: number): ActivitySnapshot {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const r = activityStmt.get({ number_id: numberId, since }) as {
    total: number;
    sent: number | null;
    delivered: number | null;
    failed: number | null;
    last_at: string | null;
  };
  const total = r.total ?? 0;
  const failed = r.failed ?? 0;
  return {
    window_minutes: windowMinutes,
    outbound_total: total,
    sent: r.sent ?? 0,
    delivered_or_read: r.delivered ?? 0,
    failed,
    failure_ratio: total > 0 ? Number((failed / total).toFixed(3)) : 0,
    last_send_at: r.last_at,
  };
}

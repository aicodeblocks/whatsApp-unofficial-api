import { db } from './index.js';
import { listNumbers, type WhatsAppNumber } from './numbers.js';
import { listCampaigns, type BroadcastCampaign } from './broadcasts.js';
import { campaignProgress, type CampaignProgress } from './broadcasts.js';
import { listHealthEvents, type HealthEventType, type Severity } from './health.js';
import { dateKeyInTz, dayKeysBetween } from '../time.js';

/**
 * Analytics & reporting (v2 Milestone 5). Reads existing data (`messages`,
 * `health_events`, `broadcast_campaigns`) rather than tracking anything new;
 * the only new state is `daily_stats`, a per-number/per-day cache of message
 * counts so repeated chart loads don't rescan all of `messages`.
 *
 * Day buckets are display-timezone calendar days (via `dateKeyInTz`), not UTC.
 * "Today" and the last `SETTLE_DAYS` days are always computed live rather than
 * cached — a message can sit `queued` for a while under anti-ban pacing/health
 * cool-off, so a day's stats aren't fully settled the moment it ends.
 */

const SETTLE_DAYS = 2;

export interface DailyStat {
  number_id: string;
  date: string;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  received_count: number;
}

function zeroStat(numberId: string, date: string): DailyStat {
  return { number_id: numberId, date, sent_count: 0, delivered_count: 0, read_count: 0, failed_count: 0, received_count: 0 };
}

/** Date keys (inclusive of today) that must always be computed live, not cached. */
function unsettledKeys(): Set<string> {
  const today = new Date();
  const keys = new Set<string>();
  for (let i = 0; i <= SETTLE_DAYS; i++) {
    keys.add(dateKeyInTz(new Date(today.getTime() - i * 86_400_000).toISOString()));
  }
  return keys;
}

const messagesInWindowStmt = db.prepare(`
  SELECT number_id, direction, status, created_at
    FROM messages
   WHERE created_at >= @from AND created_at < @to
`);

/**
 * Computes per-number counts for every day in `dateKeys` by scanning a single
 * padded UTC window (wide enough to contain every one of those display-tz
 * calendar days regardless of offset) and bucketing each row precisely in JS —
 * avoids needing exact UTC day-boundary math for an arbitrary IANA timezone.
 */
function computeStatsForDays(dateKeys: string[]): Map<string, Map<string, DailyStat>> {
  // by date -> (number_id -> DailyStat)
  const out = new Map<string, Map<string, DailyStat>>();
  if (dateKeys.length === 0) return out;
  const sorted = [...dateKeys].sort();
  const from = new Date(`${sorted[0]}T00:00:00Z`).getTime() - 86_400_000;
  const to = new Date(`${sorted[sorted.length - 1]}T00:00:00Z`).getTime() + 2 * 86_400_000;
  const wanted = new Set(dateKeys);

  const rows = messagesInWindowStmt.all({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }) as Array<{
    number_id: string;
    direction: 'inbound' | 'outbound';
    status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
    created_at: string;
  }>;

  for (const r of rows) {
    const key = dateKeyInTz(r.created_at);
    if (!wanted.has(key)) continue;
    let byNumber = out.get(key);
    if (!byNumber) {
      byNumber = new Map();
      out.set(key, byNumber);
    }
    let stat = byNumber.get(r.number_id);
    if (!stat) {
      stat = zeroStat(r.number_id, key);
      byNumber.set(r.number_id, stat);
    }
    if (r.direction === 'inbound') {
      stat.received_count++;
    } else if (r.status === 'sent') {
      stat.sent_count++;
    } else if (r.status === 'delivered') {
      stat.delivered_count++;
    } else if (r.status === 'read') {
      stat.read_count++;
    } else if (r.status === 'failed') {
      stat.failed_count++;
    }
  }
  return out;
}

const getCachedStmt = db.prepare('SELECT * FROM daily_stats WHERE number_id = ? AND date = ?');
const upsertStmt = db.prepare(`
  INSERT INTO daily_stats (number_id, date, sent_count, delivered_count, read_count, failed_count, received_count, computed_at)
  VALUES (@number_id, @date, @sent_count, @delivered_count, @read_count, @failed_count, @received_count, @now)
  ON CONFLICT(number_id, date) DO UPDATE SET
    sent_count = excluded.sent_count, delivered_count = excluded.delivered_count,
    read_count = excluded.read_count, failed_count = excluded.failed_count,
    received_count = excluded.received_count, computed_at = excluded.computed_at
`);

/** Fills the `daily_stats` cache for any missing (number, settled-day) pairs. */
export function ensureDailyStatsFor(numberIds: string[], dateKeys: string[]): void {
  const unsettled = unsettledKeys();
  const settledKeys = dateKeys.filter((k) => !unsettled.has(k));
  const missing = settledKeys.filter((k) => numberIds.some((id) => !getCachedStmt.get(id, k)));
  if (missing.length === 0) return;

  const computed = computeStatsForDays(missing);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const date of missing) {
      const byNumber = computed.get(date);
      for (const numberId of numberIds) {
        if (getCachedStmt.get(numberId, date)) continue; // already cached from a prior call
        const stat = byNumber?.get(numberId) ?? zeroStat(numberId, date);
        upsertStmt.run({ ...stat, now });
      }
    }
  });
  tx();
}

// Number filtering (when a single number_id is requested) is applied in JS
// against this range-only query, to keep a single prepared statement.
const cachedForRangeStmt = db.prepare('SELECT * FROM daily_stats WHERE date >= @from AND date <= @to');

/** Daily stats for every day in [from, to], reading the cache and live-computing unsettled days. */
export function dailyStatsInRange(from: string, to: string, numberId?: string): DailyStat[] {
  const numberIds = (numberId ? [numberId] : listNumbers().map((n) => n.id));
  const dateKeys = dayKeysBetween(from, to);
  ensureDailyStatsFor(numberIds, dateKeys);

  const unsettled = unsettledKeys();
  const unsettledInRange = dateKeys.filter((k) => unsettled.has(k));
  const liveComputed = computeStatsForDays(unsettledInRange);

  const out: DailyStat[] = [];
  const cachedRows = cachedForRangeStmt.all({ from, to }) as DailyStat[];
  const cachedByKey = new Map(cachedRows.map((r) => [`${r.number_id}:${r.date}`, r]));

  for (const date of dateKeys) {
    for (const nid of numberIds) {
      if (unsettled.has(date)) {
        out.push(liveComputed.get(date)?.get(nid) ?? zeroStat(nid, date));
      } else {
        out.push(cachedByKey.get(`${nid}:${date}`) ?? zeroStat(nid, date));
      }
    }
  }
  return out;
}

export interface KpiTotals {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  received: number;
  deliveryRate: number;
  readRate: number;
}

/** Summed KPI totals across the range (and rates relative to total outbound attempts). */
export function kpiTotals(from: string, to: string, numberId?: string): KpiTotals {
  const rows = dailyStatsInRange(from, to, numberId);
  const totals = rows.reduce(
    (acc, r) => ({
      sent: acc.sent + r.sent_count,
      delivered: acc.delivered + r.delivered_count,
      read: acc.read + r.read_count,
      failed: acc.failed + r.failed_count,
      received: acc.received + r.received_count,
    }),
    { sent: 0, delivered: 0, read: 0, failed: 0, received: 0 },
  );
  const outboundTotal = totals.sent + totals.delivered + totals.read + totals.failed;
  return {
    ...totals,
    deliveryRate: outboundTotal > 0 ? Number(((totals.delivered + totals.read) / outboundTotal).toFixed(3)) : 0,
    readRate: outboundTotal > 0 ? Number((totals.read / outboundTotal).toFixed(3)) : 0,
  };
}

export interface NumberBreakdown {
  number: WhatsAppNumber;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  received: number;
}

/** Per-number totals across the range, for the per-number breakdown chart/table. */
export function perNumberBreakdown(from: string, to: string): NumberBreakdown[] {
  const numbers = listNumbers();
  const rows = dailyStatsInRange(from, to);
  const byNumber = new Map<string, DailyStat>();
  for (const r of rows) {
    const acc = byNumber.get(r.number_id) ?? zeroStat(r.number_id, '');
    acc.sent_count += r.sent_count;
    acc.delivered_count += r.delivered_count;
    acc.read_count += r.read_count;
    acc.failed_count += r.failed_count;
    acc.received_count += r.received_count;
    byNumber.set(r.number_id, acc);
  }
  return numbers.map((number) => {
    const s = byNumber.get(number.id) ?? zeroStat(number.id, '');
    return { number, sent: s.sent_count, delivered: s.delivered_count, read: s.read_count, failed: s.failed_count, received: s.received_count };
  });
}

export interface CampaignPerformance extends BroadcastCampaign {
  progress: CampaignProgress;
}

/** Campaigns created within the range, each with its live progress breakdown. */
export function campaignPerformanceInRange(from: string, to: string): CampaignPerformance[] {
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  return listCampaigns()
    .filter((c) => c.created_at >= fromIso && c.created_at <= toIso)
    .map((c) => ({ ...c, progress: campaignProgress(c.id) }));
}

export interface HealthIncidentDay {
  date: string;
  event_type: HealthEventType;
  severity: Severity;
  count: number;
}

/** Health events in range, bucketed by display-tz day/type/severity. */
export function healthIncidentsByDay(from: string, to: string, numberId?: string): HealthIncidentDay[] {
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const events = listHealthEvents(numberId, 100_000).filter((e) => e.created_at >= fromIso && e.created_at <= toIso);

  const buckets = new Map<string, HealthIncidentDay>();
  for (const e of events) {
    const date = dateKeyInTz(e.created_at);
    const key = `${date}:${e.event_type}:${e.severity}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { date, event_type: e.event_type, severity: e.severity, count: 1 });
    }
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Hand-rolled CSV (no dependency, mirrors `src/lib/csv.ts`'s parser) of per-number daily rows in range. */
export function exportCsv(from: string, to: string, numberId?: string): string {
  const numbers = new Map(listNumbers().map((n) => [n.id, n]));
  const rows = dailyStatsInRange(from, to, numberId);
  const header = ['date', 'number_label', 'phone_number', 'sent', 'delivered', 'read', 'failed', 'received'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const n = numbers.get(r.number_id);
    const cells = [
      r.date,
      csvCell(n?.label ?? r.number_id),
      csvCell(n?.phone_number ?? ''),
      r.sent_count,
      r.delivered_count,
      r.read_count,
      r.failed_count,
      r.received_count,
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

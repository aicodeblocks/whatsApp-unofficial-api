import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import {
  campaignPerformanceInRange,
  dailyStatsInRange,
  exportCsv,
  healthIncidentsByDay,
  kpiTotals,
  perNumberBreakdown,
} from '../../db/analytics.js';
import { listNumbers } from '../../db/numbers.js';
import { dateKeyInTz, humanInTz } from '../../time.js';

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/** Default range: the last 30 days (inclusive of today), in the display timezone. */
function defaultRange(): { from: string; to: string } {
  const to = dateKeyInTz(new Date().toISOString());
  const from = dateKeyInTz(new Date(Date.now() - 29 * 86_400_000).toISOString());
  return { from, to };
}

function resolveRange(query: { from?: string; to?: string }): { from: string; to: string } {
  const def = defaultRange();
  const isDateKey = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDateKey(query.from) ? query.from : def.from;
  const to = isDateKey(query.to) ? query.to : def.to;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Aggregates a per-day view (across all numbers, or one) for the "sends over time" and "inbound" charts. */
function dailySeries(from: string, to: string, numberId?: string) {
  const rows = dailyStatsInRange(from, to, numberId);
  const byDate = new Map<string, { date: string; sent: number; delivered: number; read: number; failed: number; received: number }>();
  for (const r of rows) {
    const acc = byDate.get(r.date) ?? { date: r.date, sent: 0, delivered: 0, read: 0, failed: 0, received: 0 };
    acc.sent += r.sent_count;
    acc.delivered += r.delivered_count;
    acc.read += r.read_count;
    acc.failed += r.failed_count;
    acc.received += r.received_count;
    byDate.set(r.date, acc);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function analyticsDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string; number_id?: string } }>(
    '/analytics',
    { preHandler: app.requireAdmin, ...dash('Analytics page', 'Date-range charts, KPI tiles, per-number/campaign breakdowns, and CSV export.') },
    async (req, reply) => {
      const { from, to } = resolveRange(req.query);
      const numberId = req.query.number_id || undefined;
      const numbers = listNumbers();

      return reply.view('analytics', {
        active: 'analytics',
        from,
        to,
        numberId: numberId ?? '',
        numbers,
        kpis: kpiTotals(from, to, numberId),
        daily: dailySeries(from, to, numberId),
        perNumber: perNumberBreakdown(from, to),
        campaigns: campaignPerformanceInRange(from, to),
        healthIncidents: healthIncidentsByDay(from, to, numberId),
        tz: config.displayTz,
        humanInTz,
      });
    },
  );

  app.get<{ Querystring: { from?: string; to?: string; number_id?: string } }>(
    '/analytics/export.csv',
    { preHandler: app.requireAdmin, ...dash('Export analytics CSV (UI)', 'Downloads the per-number daily stats for the selected range as CSV.') },
    async (req, reply) => {
      const { from, to } = resolveRange(req.query);
      const csv = exportCsv(from, to, req.query.number_id || undefined);
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="waguard-analytics-${from}-to-${to}.csv"`);
      return reply.send(csv);
    },
  );
}

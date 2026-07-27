import type { FastifyInstance } from 'fastify';
import {
  campaignPerformanceInRange,
  dailyStatsInRange,
  healthIncidentsByDay,
  kpiTotals,
  perNumberBreakdown,
} from '../../db/analytics.js';

const dateKeySchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, in the display timezone (APP_TZ).' } as const;

const rangeQuerySchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: dateKeySchema,
    to: dateKeySchema,
    number_id: { type: 'string', description: 'Restrict to one linked number. Omit for all numbers.' },
  },
} as const;

function resolveRange(query: { from: string; to: string }): { from: string; to: string } {
  return query.from <= query.to ? { from: query.from, to: query.to } : { from: query.to, to: query.from };
}

const dailyStatSchema = {
  type: 'object',
  properties: {
    number_id: { type: 'string' },
    date: dateKeySchema,
    sent_count: { type: 'number' },
    delivered_count: { type: 'number' },
    read_count: { type: 'number' },
    failed_count: { type: 'number' },
    received_count: { type: 'number' },
  },
} as const;

/**
 * Analytics & reporting API (v2 Milestone 5): the same range-query building
 * blocks the /analytics dashboard page uses (src/db/analytics.ts) — no
 * separate reporting logic, just JSON instead of charts.
 */
export async function analyticsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from: string; to: string; number_id?: string } }>(
    '/api/v1/analytics/summary',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['analytics'],
        summary: 'KPI totals and per-number breakdown for a date range',
        security: [{ bearerAuth: [] }],
        querystring: rangeQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              from: dateKeySchema,
              to: dateKeySchema,
              totals: {
                type: 'object',
                properties: {
                  sent: { type: 'number' }, delivered: { type: 'number' }, read: { type: 'number' },
                  failed: { type: 'number' }, received: { type: 'number' },
                  deliveryRate: { type: 'number' }, readRate: { type: 'number' },
                },
              },
              per_number: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    number_id: { type: 'string' }, label: { type: 'string' }, phone_number: { type: ['string', 'null'] },
                    sent: { type: 'number' }, delivered: { type: 'number' }, read: { type: 'number' },
                    failed: { type: 'number' }, received: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      const totals = kpiTotals(from, to, req.query.number_id || undefined);
      const perNumber = perNumberBreakdown(from, to).map((r) => ({
        number_id: r.number.id, label: r.number.label, phone_number: r.number.phone_number,
        sent: r.sent, delivered: r.delivered, read: r.read, failed: r.failed, received: r.received,
      }));
      return { from, to, totals, per_number: perNumber };
    },
  );

  app.get<{ Querystring: { from: string; to: string; number_id?: string } }>(
    '/api/v1/analytics/daily',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['analytics'],
        summary: 'Per-number daily message counts for a date range',
        security: [{ bearerAuth: [] }],
        querystring: rangeQuerySchema,
        response: { 200: { type: 'object', properties: { days: { type: 'array', items: dailyStatSchema } } } },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      return { days: dailyStatsInRange(from, to, req.query.number_id || undefined) };
    },
  );

  app.get<{ Querystring: { from: string; to: string } }>(
    '/api/v1/analytics/campaigns',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['analytics'],
        summary: 'Campaign performance for campaigns created in a date range',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: dateKeySchema, to: dateKeySchema },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              campaigns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string' },
                    progress: {
                      type: 'object',
                      properties: {
                        queued: { type: 'number' }, sent: { type: 'number' }, delivered: { type: 'number' },
                        read: { type: 'number' }, failed: { type: 'number' }, total: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      return { campaigns: campaignPerformanceInRange(from, to) };
    },
  );

  app.get<{ Querystring: { from: string; to: string; number_id?: string } }>(
    '/api/v1/analytics/health',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['analytics'],
        summary: 'Health incidents by day for a date range',
        security: [{ bearerAuth: [] }],
        querystring: rangeQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              incidents: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    date: dateKeySchema, event_type: { type: 'string' }, severity: { type: 'string' }, count: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      return { incidents: healthIncidentsByDay(from, to, req.query.number_id || undefined) };
    },
  );
}

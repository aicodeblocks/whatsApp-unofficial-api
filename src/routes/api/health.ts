import type { FastifyInstance } from 'fastify';
import { getNumber } from '../../db/numbers.js';
import { activitySnapshot, listHealthEvents, type HealthEvent } from '../../db/health.js';
import { healthCfg } from '../../whatsapp/health.js';
import { isoInTz } from '../../time.js';
import { config } from '../../config.js';

const eventSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    number_id: { type: 'string' },
    event_type: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
    snapshot: { type: ['object', 'null'], additionalProperties: true },
    notes: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    created_at_local: { type: ['string', 'null'] },
  },
} as const;

function eventView(e: HealthEvent) {
  return {
    ...e,
    snapshot: e.snapshot ? JSON.parse(e.snapshot) : null,
    created_at_local: isoInTz(e.created_at),
  };
}

/**
 * Health monitoring API (Milestone 5): live per-number health status, its
 * cool-off window if resting, an activity snapshot, and the event timeline.
 */
export async function healthApiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/health',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['health'],
        summary: 'Get a number’s live health',
        description:
          'Returns the number’s health status (healthy | at_risk | flagged), any active cool-off window, a recent-activity snapshot, and its latest health events.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: {
            type: 'object',
            properties: {
              number_id: { type: 'string' },
              health_status: { type: 'string', enum: ['healthy', 'at_risk', 'flagged'] },
              cooloff_until: { type: ['string', 'null'], description: 'While in the future, the number is resting and held out of use.' },
              in_cooloff: { type: 'boolean' },
              recommend_switch_number: { type: 'boolean', description: 'True while resting — route sends through a different linked number.' },
              snapshot: { type: 'object', additionalProperties: true },
              events: { type: 'array', items: eventSchema },
              timezone: { type: 'string' },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = getNumber(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      const resting = !!n.cooloff_until && Date.parse(n.cooloff_until) > Date.now();
      return {
        number_id: n.id,
        health_status: n.health_status,
        cooloff_until: n.cooloff_until,
        in_cooloff: resting,
        recommend_switch_number: resting,
        snapshot: activitySnapshot(n.id, healthCfg.windowMin),
        events: listHealthEvents(n.id, 20).map(eventView),
        timezone: config.displayTz,
      };
    },
  );

  app.get<{ Querystring: { number_id?: string; limit?: number } }>(
    '/api/v1/health/events',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['health'],
        summary: 'List health events',
        description: 'Returns notable health events (newest first), optionally filtered by number_id.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            number_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        response: { 200: { type: 'object', properties: { events: { type: 'array', items: eventSchema } } } },
      },
    },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      return { events: listHealthEvents(req.query.number_id, limit).map(eventView) };
    },
  );
}

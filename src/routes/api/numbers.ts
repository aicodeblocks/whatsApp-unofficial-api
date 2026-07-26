import type { FastifyInstance } from 'fastify';
import { whatsappManager } from '../../whatsapp/manager.js';

const numberSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    phone_number: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['connecting', 'linked', 'disconnected', 'flagged'] },
    linked_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
} as const;

/**
 * Read-only API for checking linked numbers and their connection status.
 * Downstream apps use this to know which numbers are available to send from.
 */
export async function numberApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/numbers',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'List WhatsApp numbers',
        description: 'Returns all linked/linking numbers and their current connection status.',
        security: [{ bearerAuth: [] }],
        response: {
          200: { type: 'object', properties: { numbers: { type: 'array', items: numberSchema } } },
        },
      },
    },
    async () => ({
      numbers: whatsappManager.list().map(({ qr: _qr, ...n }) => n),
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Get a WhatsApp number',
        description: 'Returns a single number and its current connection status.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: numberSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      const { qr: _qr, ...rest } = n;
      return rest;
    },
  );
}

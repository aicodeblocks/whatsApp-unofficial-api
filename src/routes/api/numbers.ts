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

  // Create a number and begin the QR linking flow. Poll the /qr endpoint to
  // fetch the QR image and watch for status → linked.
  app.post<{ Body: { label?: string } }>(
    '/api/v1/numbers',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Add a WhatsApp number',
        description:
          'Creates a number and starts linking. Then poll GET /api/v1/numbers/{id}/qr for the QR code and connection status.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: { label: { type: 'string', description: 'A friendly label for the number.' } },
        },
        response: { 201: numberSchema },
      },
    },
    async (req, reply) => {
      const row = await whatsappManager.addNumber(req.body?.label ?? '');
      const n = whatsappManager.get(row.id)!;
      const { qr: _qr, ...rest } = n;
      return reply.code(201).send(rest);
    },
  );

  // The QR (and live status) for linking — the endpoint downstream systems poll
  // to render their own "scan to link" screen.
  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/qr',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Get a number’s QR code and link status',
        description:
          'While status is "connecting", `qr` is a PNG data-URI to display for scanning; it refreshes as it expires and becomes null once the number is linked.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['connecting', 'linked', 'disconnected', 'flagged'] },
              qr: { type: ['string', 'null'], description: 'PNG data-URI, or null when not awaiting a scan.' },
              phone: { type: ['string', 'null'] },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      return { status: n.status, qr: n.qr, phone: n.phone_number };
    },
  );

  // Re-open the QR flow for a disconnected number without creating a new one.
  app.post<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/relink',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Re-link a number',
        description: 'Restarts the QR linking flow for an existing number. Then poll the /qr endpoint.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: numberSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      if (!whatsappManager.get(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      await whatsappManager.relink(req.params.id);
      const { qr: _qr, ...rest } = whatsappManager.get(req.params.id)!;
      return rest;
    },
  );

  // Log out from WhatsApp and remove the number.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/numbers/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Unlink a number',
        description: 'Logs the number out of WhatsApp, deletes its session, and removes it.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      if (!whatsappManager.get(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      await whatsappManager.unlink(req.params.id);
      return { ok: true };
    },
  );
}

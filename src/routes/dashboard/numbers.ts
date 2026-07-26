import type { FastifyInstance } from 'fastify';
import { whatsappManager } from '../../whatsapp/manager.js';

/** Dashboard pages for linking and managing WhatsApp numbers. */
export async function numberDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/numbers', { preHandler: app.requireAdmin }, async (_req, reply) => {
    return reply.view('numbers', { active: 'numbers', numbers: whatsappManager.list() });
  });

  app.post<{ Body: { label?: string } }>(
    '/numbers',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      await whatsappManager.addNumber(req.body.label ?? '');
      return reply.redirect('/numbers');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/numbers/:id/relink',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      await whatsappManager.relink(req.params.id);
      return reply.redirect('/numbers');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/numbers/:id/unlink',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      await whatsappManager.unlink(req.params.id);
      return reply.redirect('/numbers');
    },
  );

  // Polled by the Numbers page to refresh the QR and flip to "linked".
  app.get<{ Params: { id: string } }>(
    '/numbers/:id/qr',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ status: n.status, qr: n.qr, phone: n.phone_number });
    },
  );
}

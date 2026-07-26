import type { FastifyInstance } from 'fastify';
import { whatsappManager } from '../../whatsapp/manager.js';

/** Shared doc metadata so these pages appear under the dashboard group. */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/** Dashboard pages for linking and managing WhatsApp numbers. */
export async function numberDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/numbers', { preHandler: app.requireAdmin, ...dash('Numbers page', 'HTML page to add, link (QR), re-link, and unlink WhatsApp numbers.') }, async (_req, reply) => {
    return reply.view('numbers', { active: 'numbers', numbers: whatsappManager.list() });
  });

  app.post<{ Body: { label?: string } }>(
    '/numbers',
    { preHandler: app.requireAdmin, ...dash('Add number (UI)', 'Creates a number and starts linking from the dashboard. Body: label (form-encoded).') },
    async (req, reply) => {
      await whatsappManager.addNumber(req.body.label ?? '');
      return reply.redirect('/numbers');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/numbers/:id/relink',
    { preHandler: app.requireAdmin, ...dash('Re-link number (UI)', 'Restarts the QR flow for a number from the dashboard.') },
    async (req, reply) => {
      await whatsappManager.relink(req.params.id);
      return reply.redirect('/numbers');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/numbers/:id/unlink',
    { preHandler: app.requireAdmin, ...dash('Unlink number (UI)', 'Logs out and removes a number from the dashboard.') },
    async (req, reply) => {
      await whatsappManager.unlink(req.params.id);
      return reply.redirect('/numbers');
    },
  );

  // Polled by the Numbers page to refresh the QR and flip to "linked".
  app.get<{ Params: { id: string } }>(
    '/numbers/:id/qr',
    { preHandler: app.requireAdmin, ...dash('Number QR/status (UI poll)', 'JSON { status, qr, phone } polled by the dashboard Numbers page. The API equivalent for downstream apps is GET /api/v1/numbers/{id}/qr.') },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ status: n.status, qr: n.qr, phone: n.phone_number });
    },
  );
}

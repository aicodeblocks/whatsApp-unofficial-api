import type { FastifyInstance } from 'fastify';
import {
  getEndpoint,
  recentDeliveries,
  rotateSecret,
  saveEndpoint,
  WEBHOOK_EVENTS,
} from '../../db/webhooks.js';
import { sendTestEvent } from '../../whatsapp/webhooks.js';

/** Shared doc metadata so these pages appear under the dashboard group. */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/** Normalize the events field (checkboxes may arrive as a string or array). */
function normalizeEvents(raw: string | string[] | undefined): string {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const valid = list.filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  return valid.join(',');
}

function render(reply: any, flash: { ok: boolean; text: string } | null) {
  return reply.view('webhooks', {
    active: 'webhooks',
    endpoint: getEndpoint() ?? null,
    allEvents: WEBHOOK_EVENTS,
    deliveries: recentDeliveries(25),
    flash,
  });
}

/** Webhook configuration + recent-delivery log dashboard. */
export async function webhookDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/webhooks',
    { preHandler: app.requireAdmin, ...dash('Webhooks page', 'Configure the outbound webhook endpoint and view recent deliveries.') },
    async (_req, reply) => render(reply, null),
  );

  app.post<{ Body: { url?: string; events?: string | string[]; active?: string } }>(
    '/webhooks',
    { preHandler: app.requireAdmin, ...dash('Save webhook (UI)', 'Create or update the webhook endpoint.') },
    async (req, reply) => {
      const url = (req.body.url ?? '').trim();
      if (!/^https?:\/\/.+/i.test(url)) {
        return render(reply, { ok: false, text: 'Enter a valid http(s) URL.' });
      }
      saveEndpoint({
        url,
        events: normalizeEvents(req.body.events),
        active: req.body.active === 'on' || req.body.active === 'true',
      });
      return render(reply, { ok: true, text: 'Webhook saved.' });
    },
  );

  app.post(
    '/webhooks/regenerate-secret',
    { preHandler: app.requireAdmin, ...dash('Regenerate secret (UI)', 'Rotate the webhook signing secret.') },
    async (_req, reply) => {
      const rotated = rotateSecret();
      return render(reply, rotated
        ? { ok: true, text: 'Signing secret regenerated — update your receiver.' }
        : { ok: false, text: 'Save an endpoint first.' });
    },
  );

  app.post(
    '/webhooks/test',
    { preHandler: app.requireAdmin, ...dash('Send test event (UI)', 'Deliver a sample event to verify the endpoint.') },
    async (_req, reply) => {
      const sent = sendTestEvent();
      return render(reply, sent
        ? { ok: true, text: 'Test event sent — check the deliveries below and your receiver.' }
        : { ok: false, text: 'Save an endpoint first.' });
    },
  );
}

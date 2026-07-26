import type { FastifyInstance } from 'fastify';
import { getContact } from '../../db/contacts.js';
import {
  jobCountsForNumber,
  listMessages,
  retryFailedForNumber,
} from '../../db/messages.js';
import { setQueuePaused } from '../../db/numbers.js';
import { dailyLimitFor } from '../../whatsapp/pacing.js';
import { enqueueMessage, EnqueueError } from '../../whatsapp/enqueue.js';
import { whatsappManager } from '../../whatsapp/manager.js';

/** Shared doc metadata so these pages appear under the dashboard group. */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/** Build the per-number queue overview the page renders. */
function overview() {
  return whatsappManager.list().map((n) => ({
    ...n,
    counts: jobCountsForNumber(n.id),
    dailyLimit: dailyLimitFor(n.warmup_started_at),
  }));
}

/** Enrich recent messages with the recipient phone for display. */
function recentMessages() {
  return listMessages(30).map((m) => ({
    ...m,
    to: getContact(m.contact_id)?.phone_number ?? '—',
  }));
}

/** Send & Queue dashboard: test-send, per-number queue counts, pause/resume, retry. */
export async function queueDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/queue',
    { preHandler: app.requireAdmin, ...dash('Send & Queue page', 'HTML page to send a test message and view/pause/resume each number’s queue.') },
    async (_req, reply) => {
      return reply.view('queue', {
        active: 'queue',
        numbers: overview(),
        messages: recentMessages(),
        flash: null,
      });
    },
  );

  app.post<{ Body: { number_id?: string; to?: string; type?: string; content?: string; caption?: string; media_url?: string; schedule_at?: string } }>(
    '/queue/send',
    { preHandler: app.requireAdmin, ...dash('Send test message (UI)', 'Enqueues a message from the dashboard test form.') },
    async (req, reply) => {
      let flash: { ok: boolean; text: string };
      try {
        const msg = enqueueMessage({
          number_id: req.body.number_id ?? '',
          to: req.body.to ?? '',
          type: (req.body.type as never) ?? 'text',
          content: req.body.content ?? null,
          caption: req.body.caption ?? null,
          media_url: req.body.media_url || null,
          schedule_at: req.body.schedule_at || null,
        });
        flash = { ok: true, text: `Queued message ${msg.id.slice(0, 8)} — watch its status below.` };
      } catch (err) {
        flash = { ok: false, text: err instanceof EnqueueError ? err.message : 'Failed to queue message.' };
      }
      return reply.view('queue', {
        active: 'queue',
        numbers: overview(),
        messages: recentMessages(),
        flash,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/queue/:id/pause',
    { preHandler: app.requireAdmin, ...dash('Pause queue (UI)', 'Pauses releasing queued messages for a number.') },
    async (req, reply) => {
      setQueuePaused(req.params.id, true);
      return reply.redirect('/queue');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/queue/:id/resume',
    { preHandler: app.requireAdmin, ...dash('Resume queue (UI)', 'Resumes releasing queued messages for a number.') },
    async (req, reply) => {
      setQueuePaused(req.params.id, false);
      return reply.redirect('/queue');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/queue/:id/retry',
    { preHandler: app.requireAdmin, ...dash('Retry failed (UI)', 'Requeues all failed messages for a number.') },
    async (req, reply) => {
      retryFailedForNumber(req.params.id);
      return reply.redirect('/queue');
    },
  );
}

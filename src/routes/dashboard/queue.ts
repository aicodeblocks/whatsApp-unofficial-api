import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
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
import { humanInTz } from '../../time.js';
import { listTemplates } from '../../db/templates.js';
import type { ButtonInput, ButtonType } from '../../db/buttons.js';

const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];

/** Collects up to 3 indexed button_type_N/button_label_N/button_payload_N form fields. */
function collectButtons(body: Record<string, unknown>): ButtonInput[] {
  const out: ButtonInput[] = [];
  for (let i = 0; i < 3; i++) {
    const type = body[`button_type_${i}`] as ButtonType | undefined;
    const label = (body[`button_label_${i}`] as string | undefined)?.trim();
    if (!type || !BUTTON_TYPES.includes(type) || !label) continue;
    out.push({ type, label, payload: (body[`button_payload_${i}`] as string | undefined)?.trim() || null });
  }
  return out;
}

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
    updated_display: humanInTz(m.updated_at),
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
        templates: listTemplates(),
        tz: config.displayTz,
        flash: null,
      });
    },
  );

  app.post<{
    Body: {
      number_id?: string; to?: string; type?: string; content?: string; caption?: string;
      media_url?: string; schedule_at?: string; template_id?: string;
      [key: string]: unknown;
    };
  }>(
    '/queue/send',
    { preHandler: app.requireAdmin, ...dash('Send test message (UI)', 'Enqueues a message from the dashboard test form. Optionally uses a template (template_id) and/or up to 3 ad-hoc buttons.') },
    async (req, reply) => {
      let flash: { ok: boolean; text: string };
      try {
        const templateId = req.body.template_id || null;
        const msg = enqueueMessage({
          number_id: req.body.number_id ?? '',
          to: req.body.to ?? '',
          type: (req.body.type as never) ?? 'text',
          content: templateId ? null : req.body.content ?? null,
          caption: templateId ? null : req.body.caption ?? null,
          media_url: templateId ? null : req.body.media_url || null,
          schedule_at: req.body.schedule_at || null,
          template_id: templateId,
          buttons: collectButtons(req.body),
        });
        flash = { ok: true, text: `Queued message ${msg.id.slice(0, 8)} — watch its status below.` };
      } catch (err) {
        flash = { ok: false, text: err instanceof EnqueueError ? err.message : 'Failed to queue message.' };
      }
      return reply.view('queue', {
        active: 'queue',
        numbers: overview(),
        messages: recentMessages(),
        templates: listTemplates(),
        tz: config.displayTz,
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

import type { FastifyInstance } from 'fastify';
import { listNumbers, inCooloff, type WhatsAppNumber } from '../../db/numbers.js';
import { activitySnapshot, listHealthEvents } from '../../db/health.js';
import { healthCfg } from '../../whatsapp/health.js';
import { humanInTz } from '../../time.js';

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

function cooloffRemaining(n: WhatsAppNumber): string | null {
  if (!inCooloff(n)) return null;
  const mins = Math.max(0, Math.round((Date.parse(n.cooloff_until!) - Date.now()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return h === Math.floor(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

/** Dashboard page showing live per-number health and the event timeline. */
export async function healthDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    { preHandler: app.requireAdmin, ...dash('Health page', 'Live per-number health status, cool-off windows, and the danger-sign event timeline.') },
    async (_req, reply) => {
      const numbers = listNumbers().map((n) => ({
        ...n,
        snapshot: activitySnapshot(n.id, healthCfg.windowMin),
        cooloff_remaining: cooloffRemaining(n),
        cooloff_until_human: humanInTz(n.cooloff_until),
      }));
      const events = listHealthEvents(undefined, 60).map((e) => ({
        ...e,
        snapshot_obj: e.snapshot ? JSON.parse(e.snapshot) : null,
        created_human: humanInTz(e.created_at),
      }));
      const labels: Record<string, string> = Object.fromEntries(numbers.map((n) => [n.id, n.label]));
      return reply.view('health', { active: 'health', numbers, events, labels, windowMin: healthCfg.windowMin });
    },
  );
}

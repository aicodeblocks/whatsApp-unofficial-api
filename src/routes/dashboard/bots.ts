import type { FastifyInstance } from 'fastify';
import {
  areBotsEnabled,
  createBot,
  deleteBot,
  getBot,
  listBots,
  setBotsEnabled,
  TRIGGER_TYPES,
  updateBot,
  type BotInput,
  type BotRuleInput,
  type TriggerType,
} from '../../db/bots.js';
import { getNumber, listNumbers } from '../../db/numbers.js';
import { getTemplate, listTemplates } from '../../db/templates.js';

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

interface FormBody {
  name?: string;
  active?: string;
  business_hours_enabled?: string;
  business_hours_start?: string;
  business_hours_end?: string;
  number_ids_json?: string;
  rules_json?: string;
}

/** Parses the JSON-encoded number_ids / rules hidden fields the form submits. */
function parseForm(body: FormBody): BotInput {
  let numberIds: string[] = [];
  try {
    const parsed = JSON.parse(body.number_ids_json ?? '[]');
    if (Array.isArray(parsed)) numberIds = parsed.map(String).filter((id) => !!getNumber(id));
  } catch {
    numberIds = [];
  }

  let rules: BotRuleInput[] = [];
  try {
    const parsed = JSON.parse(body.rules_json ?? '[]');
    if (Array.isArray(parsed)) {
      rules = parsed
        .map((r): BotRuleInput | null => {
          const trigger_type = TRIGGER_TYPES.includes(r?.trigger_type) ? (r.trigger_type as TriggerType) : 'keyword';
          const template_id = String(r?.template_id ?? '');
          const is_default_case = !!r?.is_default_case;
          // A default-case rule needs a template but no trigger value; a normal
          // rule needs both. Drop incomplete rows silently.
          if (!template_id || !getTemplate(template_id)) return null;
          const trigger_value = String(r?.trigger_value ?? '').trim();
          if (!is_default_case && !trigger_value) return null;
          return { trigger_type, trigger_value, template_id, is_default_case };
        })
        .filter((r): r is BotRuleInput => r !== null);
    }
  } catch {
    rules = [];
  }

  return {
    name: (body.name ?? '').trim() || 'Untitled bot',
    active: body.active === 'on' || body.active === 'true',
    business_hours_enabled: body.business_hours_enabled === 'on' || body.business_hours_enabled === 'true',
    business_hours_start: body.business_hours_start?.trim() || null,
    business_hours_end: body.business_hours_end?.trim() || null,
    number_ids: numberIds,
    rules,
  };
}

/** Bots: template-driven auto-reply bots bound to linked numbers, with keyword→template rules. */
export async function botsDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { edit?: string } }>(
    '/bots',
    { preHandler: app.requireAdmin, ...dash('Bots page', 'HTML list of auto-reply bots with a create/edit form.') },
    async (req, reply) => {
      const editing = req.query.edit ? getBot(req.query.edit) : null;
      return reply.view('bots', {
        active: 'bots',
        bots: listBots(),
        editing: editing ?? null,
        numbers: listNumbers(),
        templates: listTemplates(),
        botsEnabled: areBotsEnabled(),
        triggerTypes: TRIGGER_TYPES,
      });
    },
  );

  app.post<{ Body: FormBody }>(
    '/bots',
    { preHandler: app.requireAdmin, ...dash('Create a bot', 'Form fields: name, active, business hours, number_ids_json, rules_json.') },
    async (req, reply) => {
      createBot(parseForm(req.body));
      return reply.redirect('/bots');
    },
  );

  app.post<{ Params: { id: string }; Body: FormBody }>(
    '/bots/:id',
    { preHandler: app.requireAdmin, ...dash('Update a bot', 'Same fields as create.') },
    async (req, reply) => {
      if (getBot(req.params.id)) updateBot(req.params.id, parseForm(req.body));
      return reply.redirect('/bots');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/bots/:id/delete',
    { preHandler: app.requireAdmin, ...dash('Delete a bot', '') },
    async (req, reply) => {
      deleteBot(req.params.id);
      return reply.redirect('/bots');
    },
  );

  // Per-bot quick toggle (active on/off) without opening the edit form.
  app.post<{ Params: { id: string } }>(
    '/bots/:id/toggle',
    { preHandler: app.requireAdmin, ...dash('Toggle a bot active/paused', '') },
    async (req, reply) => {
      const bot = getBot(req.params.id);
      if (bot) {
        updateBot(bot.id, {
          name: bot.name,
          active: !bot.active,
          ai_enabled: bot.ai_enabled,
          persona: bot.persona,
          reshow_menu: bot.reshow_menu,
          business_hours_enabled: bot.business_hours_enabled,
          business_hours_start: bot.business_hours_start,
          business_hours_end: bot.business_hours_end,
          number_ids: bot.number_ids,
          rules: bot.rules.map((r) => ({
            trigger_type: r.trigger_type,
            trigger_value: r.trigger_value,
            template_id: r.template_id,
            is_default_case: r.is_default_case,
          })),
        });
      }
      return reply.redirect('/bots');
    },
  );

  // Global master switch for all bots.
  app.post<{ Body: { enabled?: string } }>(
    '/bots/settings',
    { preHandler: app.requireAdmin, ...dash('Set the global bots master switch', '') },
    async (req, reply) => {
      setBotsEnabled(req.body.enabled === 'on' || req.body.enabled === 'true');
      return reply.redirect('/bots');
    },
  );
}

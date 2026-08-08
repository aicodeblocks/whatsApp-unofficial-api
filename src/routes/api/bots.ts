import type { FastifyInstance } from 'fastify';
import {
  areBotsEnabled,
  createBot,
  deleteBot,
  getBot,
  listBots,
  numbersOwnedByOtherBot,
  setBotsEnabled,
  TRIGGER_TYPES,
  updateBot,
  type BotInput,
  type BotRuleInput,
  type TriggerType,
} from '../../db/bots.js';
import { getNumber } from '../../db/numbers.js';
import { getTemplate } from '../../db/templates.js';

const ruleSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    bot_id: { type: 'string' },
    trigger_type: { type: 'string', enum: TRIGGER_TYPES },
    trigger_value: { type: 'string' },
    template_id: { type: 'string' },
    priority: { type: 'integer' },
    is_default_case: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
} as const;

const botSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    active: { type: 'boolean' },
    ai_enabled: { type: 'boolean' },
    persona: { type: ['string', 'null'] },
    reshow_menu: { type: 'boolean' },
    business_hours_enabled: { type: 'boolean' },
    business_hours_start: { type: ['string', 'null'] },
    business_hours_end: { type: ['string', 'null'] },
    number_ids: { type: 'array', items: { type: 'string' } },
    rules: { type: 'array', items: ruleSchema },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
} as const;

const ruleInputSchema = {
  type: 'object',
  required: ['trigger_type', 'trigger_value', 'template_id'],
  properties: {
    trigger_type: { type: 'string', enum: TRIGGER_TYPES, description: 'keyword (whole-word), contains (substring), exact (whole message equals), or regex. All matched case-insensitively.' },
    trigger_value: { type: 'string', description: 'The text/pattern that fires this rule, e.g. "HELP", "1", "hours".' },
    template_id: { type: 'string', description: 'The template sent when this rule matches.' },
    is_default_case: { type: 'boolean', description: 'Mark as the fallback used when no other rule matches off-menu input.' },
  },
} as const;

const botBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    active: { type: 'boolean', description: 'Per-bot kill switch. When false the bot is bound but never auto-replies.' },
    ai_enabled: { type: 'boolean', description: 'Reserved for the v3 M3 AI fallback — has no effect in M1.' },
    persona: { type: 'string', description: 'Reserved for the v3 M3 AI fallback — has no effect in M1.' },
    reshow_menu: { type: 'boolean', description: 'Reserved for the v3 M3 AI fallback — has no effect in M1.' },
    business_hours_enabled: { type: 'boolean' },
    business_hours_start: { type: 'string', description: '"HH:MM" (display timezone). Outside the window the bot stays silent.' },
    business_hours_end: { type: 'string', description: '"HH:MM" (display timezone).' },
    number_ids: { type: 'array', items: { type: 'string' }, description: 'Linked-number ids this bot answers for. A number can be bound to only one bot; ids already owned by another bot are rejected.' },
    rules: { type: 'array', items: ruleInputSchema, description: 'Trigger→template rules. Array order becomes the priority (first match wins).' },
  },
} as const;

const errSchema = { type: 'object', properties: { error: { type: 'string' }, detail: { type: 'string' } } } as const;

interface BotBody {
  name: string;
  active?: boolean;
  ai_enabled?: boolean;
  persona?: string;
  reshow_menu?: boolean;
  business_hours_enabled?: boolean;
  business_hours_start?: string;
  business_hours_end?: string;
  number_ids?: string[];
  rules?: BotRuleInput[];
}

/** Validates numbers exist and rule templates exist; returns an error string or null. */
function validate(body: BotBody, botId: string | null): { error: string; detail: string } | null {
  for (const numberId of body.number_ids ?? []) {
    if (!getNumber(numberId)) return { error: 'unknown_number', detail: numberId };
  }
  const conflicts = numbersOwnedByOtherBot(botId, body.number_ids ?? []);
  if (conflicts.length) {
    return { error: 'number_already_bound', detail: `Already answered by another bot: ${conflicts.join(', ')}` };
  }
  for (const rule of body.rules ?? []) {
    if (!TRIGGER_TYPES.includes(rule.trigger_type as TriggerType)) {
      return { error: 'invalid_trigger_type', detail: String(rule.trigger_type) };
    }
    if (!getTemplate(rule.template_id)) return { error: 'unknown_template', detail: rule.template_id };
  }
  return null;
}

function toInput(body: BotBody): BotInput {
  return {
    name: body.name,
    active: body.active,
    ai_enabled: body.ai_enabled,
    persona: body.persona ?? null,
    reshow_menu: body.reshow_menu,
    business_hours_enabled: body.business_hours_enabled,
    business_hours_start: body.business_hours_start ?? null,
    business_hours_end: body.business_hours_end ?? null,
    number_ids: body.number_ids,
    rules: body.rules,
  };
}

/**
 * Auto-reply bot API — lets downstream systems manage bots, their number
 * bindings, and their trigger→template rules the same way the Bots dashboard
 * page does. The bot runs inside WaGuard; these endpoints configure it.
 */
export async function botApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/bots',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'List bots',
        description: 'All auto-reply bots with their bound numbers and rules, plus the global bots_enabled master switch.',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', properties: { bots_enabled: { type: 'boolean' }, bots: { type: 'array', items: botSchema } } } },
      },
    },
    async () => ({ bots_enabled: areBotsEnabled(), bots: listBots() }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/bots/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'Get a bot',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: botSchema, 404: errSchema },
      },
    },
    async (req, reply) => {
      const bot = getBot(req.params.id);
      if (!bot) return reply.code(404).send({ error: 'not_found' });
      return bot;
    },
  );

  app.post<{ Body: BotBody }>(
    '/api/v1/bots',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'Create a bot',
        description: 'Create a bot, optionally binding numbers and defining trigger→template rules in one call.',
        security: [{ bearerAuth: [] }],
        body: botBodySchema,
        response: { 201: botSchema, 400: errSchema },
      },
    },
    async (req, reply) => {
      const invalid = validate(req.body, null);
      if (invalid) return reply.code(400).send(invalid);
      return reply.code(201).send(createBot(toInput(req.body)));
    },
  );

  app.put<{ Params: { id: string }; Body: BotBody }>(
    '/api/v1/bots/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'Update a bot',
        description: 'Replaces the bot, its number bindings, and its rules with the supplied values.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: botBodySchema,
        response: { 200: botSchema, 400: errSchema, 404: errSchema },
      },
    },
    async (req, reply) => {
      if (!getBot(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      const invalid = validate(req.body, req.params.id);
      if (invalid) return reply.code(400).send(invalid);
      const bot = updateBot(req.params.id, toInput(req.body));
      if (!bot) return reply.code(404).send({ error: 'not_found' });
      return bot;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/bots/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'Delete a bot',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errSchema },
      },
    },
    async (req, reply) => {
      if (!deleteBot(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post<{ Body: { enabled: boolean } }>(
    '/api/v1/bots/settings',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['bots'],
        summary: 'Set the global bots master switch',
        description: 'Turn all auto-reply bots on or off at once, without changing any per-bot config.',
        security: [{ bearerAuth: [] }],
        body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
        response: { 200: { type: 'object', properties: { bots_enabled: { type: 'boolean' } } } },
      },
    },
    async (req) => {
      setBotsEnabled(!!req.body.enabled);
      return { bots_enabled: areBotsEnabled() };
    },
  );
}

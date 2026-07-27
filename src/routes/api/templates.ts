import type { FastifyInstance } from 'fastify';
import type { ButtonType } from '../../db/buttons.js';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate, type TemplateMediaType } from '../../db/templates.js';

const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];
const MEDIA_TYPES: TemplateMediaType[] = ['image', 'document', 'audio', 'video'];

const buttonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: BUTTON_TYPES },
    label: { type: 'string' },
    payload: { type: ['string', 'null'] },
  },
} as const;

const templateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    category: { type: ['string', 'null'] },
    body: { type: 'string' },
    media_path: { type: ['string', 'null'] },
    media_url: { type: ['string', 'null'] },
    media_type: { type: 'string', enum: MEDIA_TYPES },
    buttons: { type: 'array', items: buttonSchema },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
} as const;

const buttonInputSchema = {
  type: 'object',
  required: ['type', 'label'],
  properties: {
    type: { type: 'string', enum: BUTTON_TYPES },
    label: { type: 'string' },
    payload: { type: 'string', description: 'For call: a phone number. For link: a URL. For quick_reply: the reply value.' },
  },
} as const;

const templateBodySchema = {
  type: 'object',
  required: ['name', 'body'],
  properties: {
    name: { type: 'string' },
    category: { type: 'string' },
    body: { type: 'string', description: 'Message text. Use {{name}} / {{phone}} as placeholders, filled from the recipient contact at send time.' },
    media_url: { type: 'string', description: 'Optional media URL (ignored if buttons are set — buttons + media are mutually exclusive).' },
    media_type: { type: 'string', enum: MEDIA_TYPES, description: 'Only relevant if media_url is set.' },
    buttons: { type: 'array', items: buttonInputSchema, maxItems: 3, description: 'Up to 3 buttons. WhatsApp button-rendering support for personal numbers is limited — see the Templates dashboard page for details.' },
  },
} as const;

/**
 * Template library API — lets downstream systems manage reusable message
 * content (with {{placeholders}} and optional buttons) the same way the
 * Templates dashboard page does.
 */
export async function templateApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/templates',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['templates'],
        summary: 'List templates',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', properties: { templates: { type: 'array', items: templateSchema } } } },
      },
    },
    async () => ({ templates: listTemplates() }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/templates/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['templates'],
        summary: 'Get a template',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: templateSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const t = getTemplate(req.params.id);
      if (!t) return reply.code(404).send({ error: 'not_found' });
      return t;
    },
  );

  app.post<{ Body: { name: string; category?: string; body: string; media_url?: string; media_type?: TemplateMediaType; buttons?: { type: ButtonType; label: string; payload?: string }[] } }>(
    '/api/v1/templates',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['templates'],
        summary: 'Create a template',
        security: [{ bearerAuth: [] }],
        body: templateBodySchema,
        response: { 201: templateSchema },
      },
    },
    async (req, reply) => {
      const t = createTemplate({
        name: req.body.name,
        category: req.body.category ?? null,
        body: req.body.body,
        media_url: req.body.media_url ?? null,
        media_type: req.body.media_type,
        buttons: req.body.buttons,
      });
      return reply.code(201).send(t);
    },
  );

  app.put<{ Params: { id: string }; Body: { name: string; category?: string; body: string; media_url?: string; media_type?: TemplateMediaType; buttons?: { type: ButtonType; label: string; payload?: string }[] } }>(
    '/api/v1/templates/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['templates'],
        summary: 'Update a template',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: templateBodySchema,
        response: { 200: templateSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const t = updateTemplate(req.params.id, {
        name: req.body.name,
        category: req.body.category ?? null,
        body: req.body.body,
        media_url: req.body.media_url ?? null,
        media_type: req.body.media_type,
        buttons: req.body.buttons,
      });
      if (!t) return reply.code(404).send({ error: 'not_found' });
      return t;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/templates/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['templates'],
        summary: 'Delete a template',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      if (!deleteTemplate(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}

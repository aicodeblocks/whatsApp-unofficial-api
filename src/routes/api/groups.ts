import type { FastifyInstance } from 'fastify';
import { type ButtonInput, type ButtonType } from '../../db/buttons.js';
import { getGroup, listGroupsForNumber, upsertGroups } from '../../db/groups.js';
import type { MessageType } from '../../db/messages.js';
import { getNumber } from '../../db/numbers.js';
import { enqueueGroupMessage, EnqueueError } from '../../whatsapp/enqueue.js';
import { whatsappManager } from '../../whatsapp/manager.js';

const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];
const TYPES: MessageType[] = ['text', 'image', 'document', 'audio', 'video'];

const buttonInputSchema = {
  type: 'object',
  required: ['type', 'label'],
  properties: {
    type: { type: 'string', enum: BUTTON_TYPES },
    label: { type: 'string' },
    payload: { type: 'string' },
  },
} as const;

const groupSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    number_id: { type: 'string' },
    provider_group_id: { type: 'string' },
    subject: { type: ['string', 'null'] },
    participant_count: { type: 'number' },
    last_synced_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
} as const;

/**
 * WhatsApp groups API — sync the groups a linked number belongs to and send
 * messages to them through the same paced queue as everything else. Groups
 * are send-only (v2 does not create/administer groups) and are not
 * individually consent-tracked Contacts.
 */
export async function groupApiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { number_id?: string } }>(
    '/api/v1/groups',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['groups'],
        summary: 'List synced groups for a number',
        security: [{ bearerAuth: [] }],
        querystring: { type: 'object', required: ['number_id'], properties: { number_id: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { groups: { type: 'array', items: groupSchema } } } },
      },
    },
    async (req, reply) => {
      const numberId = req.query.number_id ?? '';
      if (!getNumber(numberId)) return reply.code(404).send({ error: 'unknown_number' });
      return { groups: listGroupsForNumber(numberId) };
    },
  );

  app.post<{ Body: { number_id: string } }>(
    '/api/v1/groups/sync',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['groups'],
        summary: 'Sync groups from WhatsApp',
        description: 'Refreshes the list of WhatsApp groups the given linked number belongs to.',
        security: [{ bearerAuth: [] }],
        body: { type: 'object', required: ['number_id'], properties: { number_id: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { groups: { type: 'array', items: groupSchema } } }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const numberId = req.body.number_id;
      if (!getNumber(numberId)) return reply.code(404).send({ error: 'unknown_number' });
      const rows = await whatsappManager.listGroups(numberId);
      upsertGroups(numberId, rows);
      return { groups: listGroupsForNumber(numberId) };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      type?: MessageType; content?: string; caption?: string; media_url?: string;
      schedule_at?: string; template_id?: string; buttons?: ButtonInput[];
    };
  }>(
    '/api/v1/groups/:id/send',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['groups'],
        summary: 'Send a message to a group',
        description: 'Enqueues a text, media, or templated message to a synced group, paced by the anti-ban queue like any other send.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: TYPES },
            content: { type: 'string' },
            caption: { type: 'string' },
            media_url: { type: 'string' },
            schedule_at: { type: 'string', description: 'ISO-8601.' },
            template_id: { type: 'string' },
            buttons: { type: 'array', items: buttonInputSchema, maxItems: 3 },
          },
        },
        response: { 202: { type: 'object', properties: { message_id: { type: 'string' } } }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const group = getGroup(req.params.id);
      if (!group) return reply.code(404).send({ error: 'unknown_group' });
      try {
        const message = enqueueGroupMessage({
          number_id: group.number_id,
          group_id: group.id,
          type: req.body.type ?? 'text',
          content: req.body.content ?? null,
          caption: req.body.caption ?? null,
          media_url: req.body.media_url ?? null,
          schedule_at: req.body.schedule_at ?? null,
          template_id: req.body.template_id ?? null,
          buttons: req.body.buttons,
        });
        return reply.code(202).send({ message_id: message.id });
      } catch (err) {
        if (err instanceof EnqueueError) return reply.code(400).send({ error: err.code });
        throw err;
      }
    },
  );
}

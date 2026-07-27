import type { FastifyInstance } from 'fastify';
import {
  campaignProgress,
  cancelWaitingJobsForCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  refreshCampaignStatus,
  setCampaignStatus,
  type CampaignStatus,
} from '../../db/broadcasts.js';
import { type ButtonInput, type ButtonType, getButtonsFor, setButtonsFor } from '../../db/buttons.js';
import { contactIdsInList } from '../../db/contact-lists.js';
import { launchCampaign, LaunchError } from '../../whatsapp/broadcast.js';
import type { MessageType } from '../../db/messages.js';

const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];
const TYPES: MessageType[] = ['text', 'image', 'document', 'audio', 'video'];
const STATUSES: CampaignStatus[] = ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled'];

const buttonInputSchema = {
  type: 'object',
  required: ['type', 'label'],
  properties: {
    type: { type: 'string', enum: BUTTON_TYPES },
    label: { type: 'string' },
    payload: { type: 'string' },
  },
} as const;

const campaignSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    number_id: { type: 'string' },
    list_id: { type: 'string' },
    template_id: { type: ['string', 'null'] },
    content: { type: ['string', 'null'] },
    caption: { type: ['string', 'null'] },
    media_url: { type: ['string', 'null'] },
    type: { type: 'string', enum: TYPES },
    schedule_at: { type: ['string', 'null'] },
    status: { type: 'string', enum: STATUSES },
    total_recipients: { type: 'number' },
    skipped_count: { type: 'number' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
} as const;

const progressSchema = {
  type: 'object',
  properties: {
    queued: { type: 'number' },
    sent: { type: 'number' },
    delivered: { type: 'number' },
    read: { type: 'number' },
    failed: { type: 'number' },
    total: { type: 'number' },
  },
} as const;

const campaignBodySchema = {
  type: 'object',
  required: ['name', 'number_id', 'list_id'],
  properties: {
    name: { type: 'string' },
    number_id: { type: 'string', description: 'Id of the linked number to send from.' },
    list_id: { type: 'string', description: 'Id of the contact list this campaign targets.' },
    template_id: { type: 'string', description: 'Use a saved template for content — cannot combine with content/media_url.' },
    type: { type: 'string', enum: TYPES },
    content: { type: 'string' },
    caption: { type: 'string' },
    media_url: { type: 'string' },
    schedule_at: { type: 'string', description: 'ISO-8601. If in the future, the campaign launches as "scheduled" and starts sending then.' },
    buttons: { type: 'array', items: buttonInputSchema, maxItems: 3 },
  },
} as const;

interface CampaignBody {
  name: string;
  number_id: string;
  list_id: string;
  template_id?: string;
  type?: MessageType;
  content?: string;
  caption?: string;
  media_url?: string;
  schedule_at?: string;
  buttons?: ButtonInput[];
}

/**
 * Broadcast campaigns API — create a draft, review it, launch it, and control
 * it (pause/resume/cancel) the same way the Broadcasts dashboard page does.
 * Every recipient is fanned out through the same `enqueueMessage()` used by a
 * single send, so consent/pacing/health rules apply identically.
 */
export async function broadcastApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/broadcasts',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['broadcasts'],
        summary: 'List broadcast campaigns',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', properties: { campaigns: { type: 'array', items: campaignSchema } } } },
      },
    },
    async () => ({ campaigns: listCampaigns().map((c) => refreshCampaignStatus(c.id)!) }),
  );

  app.post<{ Body: CampaignBody }>(
    '/api/v1/broadcasts',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['broadcasts'],
        summary: 'Create a campaign draft',
        description: 'Saves a new broadcast campaign as a draft. No messages are sent until POST /api/v1/broadcasts/{id}/launch.',
        security: [{ bearerAuth: [] }],
        body: campaignBodySchema,
        response: { 201: campaignSchema },
      },
    },
    async (req, reply) => {
      const campaign = createCampaign({
        name: req.body.name,
        number_id: req.body.number_id,
        list_id: req.body.list_id,
        template_id: req.body.template_id ?? null,
        type: req.body.type ?? 'text',
        content: req.body.content ?? null,
        caption: req.body.caption ?? null,
        media_url: req.body.media_url ?? null,
        schedule_at: req.body.schedule_at ?? null,
      });
      if (req.body.buttons?.length) setButtonsFor('campaign', campaign.id, req.body.buttons);
      return reply.code(201).send(campaign);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/broadcasts/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['broadcasts'],
        summary: 'Get a campaign, with live progress',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: {
            type: 'object',
            properties: {
              ...campaignSchema.properties,
              recipients_in_list: { type: 'number' },
              progress: progressSchema,
              buttons: { type: 'array', items: buttonInputSchema },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const campaign = refreshCampaignStatus(req.params.id);
      if (!campaign) return reply.code(404).send({ error: 'not_found' });
      return {
        ...campaign,
        recipients_in_list: contactIdsInList(campaign.list_id).length,
        progress: campaignProgress(campaign.id),
        buttons: getButtonsFor('campaign', campaign.id),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/broadcasts/:id/launch',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['broadcasts'],
        summary: 'Launch a draft campaign',
        description: 'Fans out one message per eligible recipient in the target list, queued under the anti-ban pacing engine.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: campaignSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
          409: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const campaign = launchCampaign(req.params.id);
        return campaign;
      } catch (err) {
        if (err instanceof LaunchError) {
          const code = err.code === 'unknown_campaign' ? 404 : 409;
          return reply.code(code).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  function applyStatus(id: string, status: CampaignStatus): ReturnType<typeof getCampaign> {
    setCampaignStatus(id, status);
    if (status === 'cancelled') cancelWaitingJobsForCampaign(id);
    return getCampaign(id);
  }

  const statusRoute = (path: string, status: CampaignStatus, summary: string) => {
    app.post<{ Params: { id: string } }>(
      path,
      {
        preHandler: app.requireApiToken,
        schema: {
          tags: ['broadcasts'],
          summary,
          security: [{ bearerAuth: [] }],
          params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          response: { 200: campaignSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
        },
      },
      async (req, reply) => {
        if (!getCampaign(req.params.id)) return reply.code(404).send({ error: 'not_found' });
        return applyStatus(req.params.id, status);
      },
    );
  };

  statusRoute('/api/v1/broadcasts/:id/pause', 'paused', 'Pause a campaign');
  statusRoute('/api/v1/broadcasts/:id/resume', 'sending', 'Resume a campaign');
  statusRoute('/api/v1/broadcasts/:id/cancel', 'cancelled', 'Cancel a campaign');
}

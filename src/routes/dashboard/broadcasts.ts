import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import {
  campaignProgress,
  cancelWaitingJobsForCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  refreshCampaignStatus,
  setCampaignStatus,
  type BroadcastCampaign,
} from '../../db/broadcasts.js';
import { setButtonsFor, getButtonsFor } from '../../db/buttons.js';
import { listLists, contactIdsInList } from '../../db/contact-lists.js';
import { listGroupsForNumber, getGroup, upsertGroups } from '../../db/groups.js';
import { listTemplates } from '../../db/templates.js';
import { whatsappManager } from '../../whatsapp/manager.js';
import { launchCampaign } from '../../whatsapp/broadcast.js';
import { enqueueGroupMessage, EnqueueError } from '../../whatsapp/enqueue.js';
import { collectButtons } from '../../lib/buttons-form.js';
import { dailyLimitFor } from '../../whatsapp/pacing.js';

/** Shared doc metadata so these pages appear under the dashboard group. */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

function listData() {
  const numbers = whatsappManager.list();
  return {
    active: 'broadcasts',
    numbers,
    linked: numbers.filter((n) => n.status === 'linked'),
    lists: listLists(),
    templates: listTemplates(),
    campaigns: listCampaigns().map((c) => ({
      ...refreshCampaignStatus(c.id)!,
      progress: campaignProgress(c.id),
    })),
    groups: numbers.map((n) => ({ number: n, rows: listGroupsForNumber(n.id) })),
    tz: config.displayTz,
    flash: null as { ok: boolean; text: string } | null,
  };
}

function campaignDetailData(campaign: BroadcastCampaign) {
  const recipients = contactIdsInList(campaign.list_id).length;
  const number = whatsappManager.get(campaign.number_id);
  const dailyLimit = number ? dailyLimitFor(number.warmup_started_at) : 0;
  const estimatedDays = dailyLimit > 0 ? Math.ceil(recipients / dailyLimit) : null;
  return {
    campaign,
    progress: campaignProgress(campaign.id),
    recipients,
    dailyLimit,
    estimatedDays,
    tz: config.displayTz,
  };
}

export async function broadcastsDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/broadcasts',
    { preHandler: app.requireAdmin, ...dash('Broadcasts page', 'HTML page to create/launch broadcast campaigns and sync/send to WhatsApp groups.') },
    async (_req, reply) => reply.view('broadcasts', listData()),
  );

  app.post<{
    Body: {
      name?: string; number_id?: string; list_id?: string; template_id?: string;
      type?: string; content?: string; caption?: string; media_url?: string; schedule_at?: string;
      [key: string]: unknown;
    };
  }>(
    '/broadcasts',
    { preHandler: app.requireAdmin, ...dash('Create campaign draft (UI)', 'Saves a new broadcast campaign as a draft — no messages are sent until it is launched.') },
    async (req, reply) => {
      let flash: { ok: boolean; text: string };
      try {
        const templateId = req.body.template_id || null;
        const campaign = createCampaign({
          name: req.body.name?.trim() || 'Untitled campaign',
          number_id: req.body.number_id ?? '',
          list_id: req.body.list_id ?? '',
          template_id: templateId,
          type: (req.body.type as never) ?? 'text',
          content: templateId ? null : req.body.content || null,
          caption: templateId ? null : req.body.caption || null,
          media_url: templateId ? null : req.body.media_url || null,
          schedule_at: req.body.schedule_at || null,
        });
        setButtonsFor('campaign', campaign.id, collectButtons(req.body));
        return reply.redirect(`/broadcasts/${campaign.id}`);
      } catch (err) {
        flash = { ok: false, text: err instanceof Error ? err.message : 'Failed to create campaign.' };
        return reply.view('broadcasts', { ...listData(), flash });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/broadcasts/:id',
    { preHandler: app.requireAdmin, ...dash('Campaign detail page', 'Shows a draft campaign’s recipient/window estimate, or live progress once launched.') },
    async (req, reply) => {
      const campaign = refreshCampaignStatus(req.params.id);
      if (!campaign) return reply.code(404).view('broadcasts', { ...listData(), flash: { ok: false, text: 'No such campaign.' } });
      return reply.view('broadcast-detail', {
        active: 'broadcasts',
        buttons: getButtonsFor('campaign', campaign.id),
        ...campaignDetailData(campaign),
        flash: null,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/broadcasts/:id/launch',
    { preHandler: app.requireAdmin, ...dash('Launch campaign (UI)', 'Fans out the draft to every eligible recipient in its target list, under the anti-ban queue.') },
    async (req, reply) => {
      try {
        launchCampaign(req.params.id);
      } catch {
        /* surfaced via the redirected page's own state (status stays draft) */
      }
      return reply.redirect(`/broadcasts/${req.params.id}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/broadcasts/:id/pause',
    { preHandler: app.requireAdmin, ...dash('Pause campaign (UI)', 'Holds a sending/scheduled campaign’s remaining jobs without cancelling them.') },
    async (req, reply) => {
      setCampaignStatus(req.params.id, 'paused');
      return reply.redirect(`/broadcasts/${req.params.id}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/broadcasts/:id/resume',
    { preHandler: app.requireAdmin, ...dash('Resume campaign (UI)', 'Resumes a paused campaign.') },
    async (req, reply) => {
      setCampaignStatus(req.params.id, 'sending');
      return reply.redirect(`/broadcasts/${req.params.id}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/broadcasts/:id/cancel',
    { preHandler: app.requireAdmin, ...dash('Cancel campaign (UI)', 'Cancels a campaign and stops its remaining queued jobs.') },
    async (req, reply) => {
      setCampaignStatus(req.params.id, 'cancelled');
      cancelWaitingJobsForCampaign(req.params.id);
      return reply.redirect(`/broadcasts/${req.params.id}`);
    },
  );

  // --- Groups ---

  app.post<{ Body: { number_id?: string } }>(
    '/broadcasts/groups/sync',
    { preHandler: app.requireAdmin, ...dash('Sync groups (UI)', 'Refreshes the list of WhatsApp groups a linked number belongs to.') },
    async (req, reply) => {
      const numberId = req.body.number_id ?? '';
      const rows = await whatsappManager.listGroups(numberId);
      upsertGroups(numberId, rows);
      return reply.redirect('/broadcasts');
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      number_id?: string; template_id?: string; type?: string; content?: string; caption?: string;
      media_url?: string; schedule_at?: string; [key: string]: unknown;
    };
  }>(
    '/broadcasts/groups/:id/send',
    { preHandler: app.requireAdmin, ...dash('Send to group (UI)', 'Enqueues a message to a synced WhatsApp group through the paced queue.') },
    async (req, reply) => {
      let flash: { ok: boolean; text: string };
      try {
        const group = getGroup(req.params.id);
        if (!group) throw new EnqueueError('unknown_group', 'No such group.');
        const templateId = req.body.template_id || null;
        enqueueGroupMessage({
          number_id: group.number_id,
          group_id: group.id,
          type: (req.body.type as never) ?? 'text',
          content: templateId ? null : req.body.content ?? null,
          caption: templateId ? null : req.body.caption ?? null,
          media_url: templateId ? null : req.body.media_url || null,
          schedule_at: req.body.schedule_at || null,
          template_id: templateId,
          buttons: collectButtons(req.body),
        });
        flash = { ok: true, text: `Queued a message to ${group.subject ?? 'the group'}.` };
      } catch (err) {
        flash = { ok: false, text: err instanceof EnqueueError ? err.message : 'Failed to queue group message.' };
      }
      return reply.view('broadcasts', { ...listData(), flash });
    },
  );
}

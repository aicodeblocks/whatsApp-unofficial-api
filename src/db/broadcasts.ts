import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import type { MessageType } from './messages.js';

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled';

export interface BroadcastCampaign {
  id: string;
  name: string;
  number_id: string;
  list_id: string;
  template_id: string | null;
  content: string | null;
  caption: string | null;
  media_url: string | null;
  media_path: string | null;
  type: MessageType;
  schedule_at: string | null;
  status: CampaignStatus;
  total_recipients: number;
  skipped_count: number;
  created_at: string;
  updated_at: string;
}

export interface NewCampaign {
  name: string;
  number_id: string;
  list_id: string;
  template_id?: string | null;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
  type?: MessageType;
  schedule_at?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO broadcast_campaigns
    (id, name, number_id, list_id, template_id, content, caption, media_url, media_path, type,
     schedule_at, status, created_at, updated_at)
  VALUES
    (@id, @name, @number_id, @list_id, @template_id, @content, @caption, @media_url, @media_path, @type,
     @schedule_at, 'draft', @now, @now)
`);
const getStmt = db.prepare('SELECT * FROM broadcast_campaigns WHERE id = ?');
const listStmt = db.prepare('SELECT * FROM broadcast_campaigns ORDER BY created_at DESC');
const setStatusStmt = db.prepare(
  'UPDATE broadcast_campaigns SET status = @status, updated_at = @now WHERE id = @id',
);
const launchStmt = db.prepare(`
  UPDATE broadcast_campaigns
     SET total_recipients = @total_recipients, skipped_count = @skipped_count,
         status = @status, updated_at = @now
   WHERE id = @id
`);

export function createCampaign(c: NewCampaign): BroadcastCampaign {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt.run({
    id,
    name: c.name,
    number_id: c.number_id,
    list_id: c.list_id,
    template_id: c.template_id ?? null,
    content: c.content ?? null,
    caption: c.caption ?? null,
    media_url: c.media_url ?? null,
    media_path: c.media_path ?? null,
    type: c.type ?? 'text',
    schedule_at: c.schedule_at ?? null,
    now,
  });
  return getCampaign(id)!;
}

export function getCampaign(id: string): BroadcastCampaign | undefined {
  return getStmt.get(id) as BroadcastCampaign | undefined;
}

export function listCampaigns(): BroadcastCampaign[] {
  return listStmt.all() as BroadcastCampaign[];
}

export function setCampaignStatus(id: string, status: CampaignStatus): void {
  setStatusStmt.run({ id, status, now: new Date().toISOString() });
}

/** Record the outcome of launching a draft: how many recipients were queued vs skipped. */
export function updateCampaignLaunch(
  id: string,
  fields: { total_recipients: number; skipped_count: number; status: CampaignStatus },
): void {
  launchStmt.run({ id, ...fields, now: new Date().toISOString() });
}

const cancelWaitingJobsStmt = db.prepare(`
  UPDATE queued_jobs
     SET state = 'failed', last_error = 'campaign_cancelled', updated_at = @now
   WHERE state = 'waiting'
     AND message_id IN (SELECT id FROM messages WHERE broadcast_id = @broadcast_id)
`);

/** Stop a cancelled campaign from being polled forever by the queue gate. */
export function cancelWaitingJobsForCampaign(id: string): void {
  cancelWaitingJobsStmt.run({ broadcast_id: id, now: new Date().toISOString() });
}

const progressStmt = db.prepare(`
  SELECT status, COUNT(*) AS n FROM messages WHERE broadcast_id = ? GROUP BY status
`);
const activeJobCountStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM queued_jobs j
    JOIN messages m ON m.id = j.message_id
   WHERE m.broadcast_id = ? AND j.state IN ('waiting', 'processing')
`);

export interface CampaignProgress {
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  total: number;
}

/** Live per-status message counts for a campaign, for the progress view. */
export function campaignProgress(id: string): CampaignProgress {
  const out: CampaignProgress = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, total: 0 };
  for (const r of progressStmt.all(id) as Array<{ status: keyof CampaignProgress; n: number }>) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * Self-healing status rollup: a `sending`/`scheduled` campaign with no more
 * active jobs is done. Called lazily wherever a campaign is read (list,
 * detail, API) — same pattern as the Overview page's live status cards.
 */
export function refreshCampaignStatus(id: string): BroadcastCampaign | undefined {
  let campaign = getCampaign(id);
  if (!campaign) return undefined;
  if (campaign.status !== 'sending' && campaign.status !== 'scheduled') return campaign;

  // A scheduled campaign whose start time has passed is now actively sending.
  if (campaign.status === 'scheduled' && campaign.schedule_at && Date.parse(campaign.schedule_at) <= Date.now()) {
    setCampaignStatus(id, 'sending');
    campaign = getCampaign(id)!;
  }

  const { n } = activeJobCountStmt.get(id) as { n: number };
  if (n === 0 && campaign.total_recipients > 0) {
    setCampaignStatus(id, 'completed');
    return getCampaign(id);
  }
  return campaign;
}

/**
 * Launches a draft broadcast campaign: fans out one `enqueueMessage()` call per
 * recipient in the target list. Reuses `enqueueMessage`'s existing consent,
 * validation, template-resolution, and placeholder-fill logic rather than
 * reimplementing any of it — a recipient that fails those checks (blocked,
 * consent-required, etc.) is simply counted as skipped. Shared by the
 * Broadcasts dashboard page and the broadcasts API.
 */
import { type CampaignStatus, getCampaign, updateCampaignLaunch } from '../db/broadcasts.js';
import { getButtonsFor } from '../db/buttons.js';
import { contactIdsInList } from '../db/contact-lists.js';
import { getContact } from '../db/contacts.js';
import { enqueueMessage, EnqueueError } from './enqueue.js';

export class LaunchError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function launchCampaign(id: string): ReturnType<typeof getCampaign> {
  const campaign = getCampaign(id);
  if (!campaign) throw new LaunchError('unknown_campaign', 'No such campaign.');
  if (campaign.status !== 'draft') {
    throw new LaunchError('already_launched', 'This campaign has already been launched.');
  }

  const buttons = getButtonsFor('campaign', campaign.id).map((b) => ({
    type: b.type,
    label: b.label,
    payload: b.payload,
  }));
  const contactIds = contactIdsInList(campaign.list_id);

  let queued = 0;
  let skipped = 0;
  for (const contactId of contactIds) {
    const contact = getContact(contactId);
    if (!contact) {
      skipped++;
      continue;
    }
    try {
      enqueueMessage({
        number_id: campaign.number_id,
        to: contact.phone_number,
        type: campaign.type,
        content: campaign.content,
        caption: campaign.caption,
        media_url: campaign.media_url,
        media_path: campaign.media_path,
        template_id: campaign.template_id,
        buttons,
        schedule_at: campaign.schedule_at,
        broadcast_id: campaign.id,
      });
      queued++;
    } catch (err) {
      if (err instanceof EnqueueError) {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  const status: CampaignStatus =
    campaign.schedule_at && Date.parse(campaign.schedule_at) > Date.now() ? 'scheduled' : 'sending';
  updateCampaignLaunch(campaign.id, { total_recipients: queued, skipped_count: skipped, status });
  return getCampaign(campaign.id);
}

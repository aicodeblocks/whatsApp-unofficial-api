/**
 * Turns a send request into a stored Message + a QueuedJob for the worker.
 * Shared by the API and the dashboard test-send form. Does basic validation
 * (recipient format, required fields), enforces consent (blocked recipients are
 * rejected; unknown recipients follow CONSENT_UNKNOWN_POLICY), and defers the
 * "is this number actually on WhatsApp?" check to the queue (just before send).
 *
 * `enqueueGroupMessage` is the group-send counterpart: it shares template
 * resolution and validation with `enqueueMessage` but skips the
 * contact/consent/placeholder machinery entirely — a WhatsApp group isn't an
 * individually consent-tracked Contact.
 */
import { resolveContact } from '../db/contacts.js';
import { getGroup } from '../db/groups.js';
import { createJob, createMessage, type Message, type MessageType } from '../db/messages.js';
import { getNumber } from '../db/numbers.js';
import { type ButtonInput, setButtonsFor } from '../db/buttons.js';
import { fillPlaceholders, getTemplate } from '../db/templates.js';

/** Policy for recipients whose consent is 'unknown': 'allow' (default) | 'block'. */
const UNKNOWN_POLICY = (process.env.CONSENT_UNKNOWN_POLICY ?? 'allow').toLowerCase() === 'block'
  ? 'block'
  : 'allow';

const MEDIA_TYPES: MessageType[] = ['image', 'document', 'audio', 'video'];
const ALL_TYPES: MessageType[] = ['text', ...MEDIA_TYPES];

export class EnqueueError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Normalize a recipient to bare international digits, or throw if implausible. */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new EnqueueError('invalid_recipient', 'Recipient must be 8–15 digits in international format.');
  }
  return digits;
}

/** Ad-hoc content/media, or a template_id — the shape both send paths share. */
interface RawContent {
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
  template_id?: string | null;
  buttons?: ButtonInput[];
}

interface ResolvedContent {
  type: MessageType;
  content: string | null;
  caption: string | null;
  media_url: string | null;
  media_path: string | null;
  buttons: ButtonInput[];
}

/**
 * Resolves a template (or ad-hoc content) into a concrete type/content/media
 * shape, applying the same rules everywhere: a template supplies its own
 * content and can't be mixed with ad-hoc content; buttons always force a text
 * send; and the resulting type/content/media combination must be well-formed.
 * Shared by `enqueueMessage` and `enqueueGroupMessage`.
 */
function resolveContent(raw: RawContent): ResolvedContent {
  let buttons: ButtonInput[] = raw.buttons ?? [];
  let type = raw.type;
  let content = raw.content ?? null;
  let caption = raw.caption ?? null;
  let media_url = raw.media_url ?? null;
  let media_path = raw.media_path ?? null;

  if (raw.template_id) {
    if (raw.content || raw.media_url || raw.media_path) {
      throw new EnqueueError(
        'template_and_content',
        'Choose either a template or ad-hoc content/media, not both.',
      );
    }
    const template = getTemplate(raw.template_id);
    if (!template) throw new EnqueueError('unknown_template', 'No such template.');

    buttons = template.buttons.length ? template.buttons : buttons;
    // Buttons + media are mutually exclusive in v2 — a template with buttons
    // always sends as text, regardless of any media it also has.
    const hasMedia = !buttons.length && !!(template.media_path || template.media_url);
    type = hasMedia ? template.media_type : 'text';
    content = hasMedia ? null : template.body;
    caption = hasMedia ? template.body : null;
    media_url = hasMedia ? template.media_url : null;
    media_path = hasMedia ? template.media_path : null;
  }

  // Buttons force a text send regardless of type/media (mutually exclusive in v2).
  if (buttons.length && type !== 'text') {
    type = 'text';
    media_url = null;
    media_path = null;
  }

  if (!ALL_TYPES.includes(type)) {
    throw new EnqueueError('invalid_type', `type must be one of: ${ALL_TYPES.join(', ')}.`);
  }

  if (buttons.length) {
    if (!content || !content.trim()) {
      throw new EnqueueError('missing_content', 'A message with buttons needs non-empty text content.');
    }
  } else if (type === 'text') {
    if (!content || !content.trim()) {
      throw new EnqueueError('missing_content', 'A text message needs non-empty content.');
    }
    // Guard against the common mistake of filling a media URL/file but leaving
    // Type on "text" — that would silently drop the media. Fail loudly instead.
    if (media_url || media_path) {
      throw new EnqueueError(
        'type_media_mismatch',
        'Type is "text" but a media URL/file was provided. Select a media type (image, document, audio, or video) to send media, or remove the media.',
      );
    }
  } else if (!media_url && !media_path) {
    throw new EnqueueError('missing_media', `A ${type} message needs media_url or an uploaded file.`);
  }

  return { type, content, caption, media_url, media_path, buttons };
}

/** Parses an optional schedule_at into an ISO timestamp; "now" if absent or already past. */
function resolveScheduledAt(scheduleAt: string | null | undefined): string {
  if (!scheduleAt) return new Date().toISOString();
  const t = Date.parse(scheduleAt);
  if (!Number.isFinite(t)) {
    throw new EnqueueError('invalid_schedule', 'schedule_at must be an ISO-8601 timestamp.');
  }
  return t > Date.now() ? new Date(t).toISOString() : new Date().toISOString();
}

export interface EnqueueInput {
  number_id: string;
  to: string;
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
  schedule_at?: string | null;
  /** Use a saved template's body/media/buttons as the message content. */
  template_id?: string | null;
  /** Ad-hoc buttons (ignored if template_id is set — the template's own buttons win). */
  buttons?: ButtonInput[];
  /** Links this message back to the broadcast campaign that generated it. */
  broadcast_id?: string | null;
}

export function enqueueMessage(rawInput: EnqueueInput): Message {
  const number = getNumber(rawInput.number_id);
  if (!number) throw new EnqueueError('unknown_number', 'No such sending number.');

  const resolved = resolveContent(rawInput);
  const phone = normalizePhone(rawInput.to);
  const scheduledAt = resolveScheduledAt(rawInput.schedule_at);
  const contact = resolveContact(phone);

  // Consent guardrails — the top ban trigger is messaging people who don't
  // want it. Blocked contacts are always rejected; unknown contacts follow the
  // configured policy.
  if (contact.consent_status === 'blocked') {
    throw new EnqueueError(
      'recipient_blocked',
      'This recipient is blocked (consent withdrawn). Sending is not allowed.',
    );
  }
  if (contact.consent_status === 'unknown' && UNKNOWN_POLICY === 'block') {
    throw new EnqueueError(
      'consent_required',
      'Recipient consent is unknown and the policy requires opt-in. Mark the contact opted-in first.',
    );
  }

  // Fill {{name}}/{{phone}} from the resolved contact — applies to ad-hoc text
  // too, not just templates, since there's no harm in it.
  const nameField = contact.display_name ?? contact.phone_number;
  const filledContent = resolved.content
    ? fillPlaceholders(resolved.content, { name: nameField, phone: contact.phone_number })
    : resolved.content;
  const filledCaption = resolved.caption
    ? fillPlaceholders(resolved.caption, { name: nameField, phone: contact.phone_number })
    : resolved.caption;

  const message = createMessage({
    number_id: number.id,
    contact_id: contact.id,
    type: resolved.type,
    content: resolved.type === 'text' ? filledContent : null,
    caption: resolved.type === 'text' ? null : filledCaption ?? null,
    media_url: resolved.media_url,
    media_path: resolved.media_path,
    template_id: rawInput.template_id ?? null,
    broadcast_id: rawInput.broadcast_id ?? null,
  });
  if (resolved.buttons.length) setButtonsFor('message', message.id, resolved.buttons);
  createJob(message.id, number.id, scheduledAt);
  return message;
}

export interface EnqueueGroupInput {
  number_id: string;
  group_id: string;
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
  schedule_at?: string | null;
  template_id?: string | null;
  buttons?: ButtonInput[];
}

/**
 * Group counterpart to `enqueueMessage`. No consent/contact resolution and no
 * `{{placeholder}}` fill (a group isn't a Contact with a name/phone) — the
 * message still goes through the same paced queue as everything else.
 */
export function enqueueGroupMessage(rawInput: EnqueueGroupInput): Message {
  const number = getNumber(rawInput.number_id);
  if (!number) throw new EnqueueError('unknown_number', 'No such sending number.');
  const group = getGroup(rawInput.group_id);
  if (!group || group.number_id !== number.id) {
    throw new EnqueueError('unknown_group', 'No such group for this number.');
  }

  const resolved = resolveContent(rawInput);
  const scheduledAt = resolveScheduledAt(rawInput.schedule_at);

  const message = createMessage({
    number_id: number.id,
    contact_id: null,
    group_id: group.id,
    type: resolved.type,
    content: resolved.type === 'text' ? resolved.content : null,
    caption: resolved.type === 'text' ? null : resolved.caption,
    media_url: resolved.media_url,
    media_path: resolved.media_path,
    template_id: rawInput.template_id ?? null,
  });
  if (resolved.buttons.length) setButtonsFor('message', message.id, resolved.buttons);
  createJob(message.id, number.id, scheduledAt);
  return message;
}

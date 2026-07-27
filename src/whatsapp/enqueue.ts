/**
 * Turns a send request into a stored Message + a QueuedJob for the worker.
 * Shared by the API and the dashboard test-send form. Does basic validation
 * (recipient format, required fields), enforces consent (blocked recipients are
 * rejected; unknown recipients follow CONSENT_UNKNOWN_POLICY), and defers the
 * "is this number actually on WhatsApp?" check to the queue (just before send).
 */
import { resolveContact } from '../db/contacts.js';
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
}

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

export function enqueueMessage(rawInput: EnqueueInput): Message {
  const number = getNumber(rawInput.number_id);
  if (!number) throw new EnqueueError('unknown_number', 'No such sending number.');

  let input = rawInput;
  let buttons: ButtonInput[] = rawInput.buttons ?? [];

  // A template supplies its own content/media/buttons — ad-hoc content on the
  // same request would be ambiguous, so require picking one or the other.
  if (rawInput.template_id) {
    if (rawInput.content || rawInput.media_url || rawInput.media_path) {
      throw new EnqueueError(
        'template_and_content',
        'Choose either a template or ad-hoc content/media, not both.',
      );
    }
    const template = getTemplate(rawInput.template_id);
    if (!template) throw new EnqueueError('unknown_template', 'No such template.');

    buttons = template.buttons.length ? template.buttons : buttons;
    // Buttons + media are mutually exclusive in v2 — a template with buttons
    // always sends as text, regardless of any media it also has.
    const hasMedia = !buttons.length && !!(template.media_path || template.media_url);
    input = {
      ...rawInput,
      type: hasMedia ? template.media_type : 'text',
      content: hasMedia ? null : template.body,
      caption: hasMedia ? template.body : null,
      media_url: hasMedia ? template.media_url : null,
      media_path: hasMedia ? template.media_path : null,
    };
  }

  // Buttons force a text send regardless of type/media (mutually exclusive in v2).
  if (buttons.length && input.type !== 'text') {
    input = { ...input, type: 'text', media_url: null, media_path: null };
  }

  const type = input.type ?? 'text';
  if (!ALL_TYPES.includes(type)) {
    throw new EnqueueError('invalid_type', `type must be one of: ${ALL_TYPES.join(', ')}.`);
  }

  // Buttons force a text send regardless of type/media — validated below.
  if (buttons.length) {
    if (!input.content || !input.content.trim()) {
      throw new EnqueueError('missing_content', 'A message with buttons needs non-empty text content.');
    }
  } else if (type === 'text') {
    if (!input.content || !input.content.trim()) {
      throw new EnqueueError('missing_content', 'A text message needs non-empty content.');
    }
    // Guard against the common mistake of filling a media URL/file but leaving
    // Type on "text" — that would silently drop the media. Fail loudly instead.
    if (input.media_url || input.media_path) {
      throw new EnqueueError(
        'type_media_mismatch',
        'Type is "text" but a media URL/file was provided. Select a media type (image, document, audio, or video) to send media, or remove the media.',
      );
    }
  } else if (!input.media_url && !input.media_path) {
    throw new EnqueueError('missing_media', `A ${type} message needs media_url or an uploaded file.`);
  }

  const phone = normalizePhone(input.to);

  // Scheduled send: must parse and be in the future (else send now).
  let scheduledAt = new Date().toISOString();
  if (input.schedule_at) {
    const t = Date.parse(input.schedule_at);
    if (!Number.isFinite(t)) {
      throw new EnqueueError('invalid_schedule', 'schedule_at must be an ISO-8601 timestamp.');
    }
    if (t > Date.now()) scheduledAt = new Date(t).toISOString();
  }

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
  const filledContent = input.content ? fillPlaceholders(input.content, { name: nameField, phone: contact.phone_number }) : input.content;
  const filledCaption = input.caption ? fillPlaceholders(input.caption, { name: nameField, phone: contact.phone_number }) : input.caption;

  const message = createMessage({
    number_id: number.id,
    contact_id: contact.id,
    type,
    content: type === 'text' ? filledContent : null,
    caption: type === 'text' ? null : filledCaption ?? null,
    media_url: input.media_url ?? null,
    media_path: input.media_path ?? null,
    template_id: rawInput.template_id ?? null,
  });
  if (buttons.length) setButtonsFor('message', message.id, buttons);
  createJob(message.id, number.id, scheduledAt);
  return message;
}

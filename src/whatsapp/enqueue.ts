/**
 * Turns a send request into a stored Message + a QueuedJob for the worker.
 * Shared by the API and the dashboard test-send form. Does basic validation
 * (recipient format, required fields) but no WhatsApp existence check — that is
 * Milestone 5's job — and no consent enforcement yet.
 */
import { resolveContact } from '../db/contacts.js';
import { createJob, createMessage, type Message, type MessageType } from '../db/messages.js';
import { getNumber } from '../db/numbers.js';

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

export function enqueueMessage(input: EnqueueInput): Message {
  const number = getNumber(input.number_id);
  if (!number) throw new EnqueueError('unknown_number', 'No such sending number.');

  const type = input.type ?? 'text';
  if (!ALL_TYPES.includes(type)) {
    throw new EnqueueError('invalid_type', `type must be one of: ${ALL_TYPES.join(', ')}.`);
  }

  if (type === 'text') {
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
  const message = createMessage({
    number_id: number.id,
    contact_id: contact.id,
    type,
    content: type === 'text' ? input.content : null,
    caption: type === 'text' ? null : input.caption ?? null,
    media_url: input.media_url ?? null,
    media_path: input.media_path ?? null,
  });
  createJob(message.id, number.id, scheduledAt);
  return message;
}

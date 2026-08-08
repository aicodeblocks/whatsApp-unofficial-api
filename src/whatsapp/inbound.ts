/**
 * Turns a raw Baileys incoming message into a stored inbound Message row and a
 * `message.inbound` webhook. Media is downloaded to the data volume and exposed
 * to receivers via an authenticated media-download URL (built in webhooks.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { markContacted, resolveContact, setConsent } from '../db/contacts.js';
import { getGroupByProviderId } from '../db/groups.js';
import {
  createInboundMessage,
  getMessageByProviderId,
  type MessageType,
} from '../db/messages.js';
import { runBotReply } from './bot.js';
import { emitInbound } from './webhooks.js';

const MEDIA_DIR = resolve(config.dataDir, 'media');

/** STOP-style opt-out keywords (M4 detects; M5 enforces consent). */
const STOP_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'stopall',
  'optout',
  'opt-out',
]);

/** True if the whole (trimmed, lowercased) message body is an opt-out keyword. */
export function isStopKeyword(text: string | null | undefined): boolean {
  if (!text) return false;
  return STOP_KEYWORDS.has(text.trim().toLowerCase());
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
};

function extFor(mimetype: string | undefined, fileName: string | undefined): string {
  if (fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot > 0) return fileName.slice(dot);
  }
  const base = (mimetype ?? '').split(';')[0].trim();
  return EXT_BY_MIME[base] ?? '';
}

interface Extracted {
  type: MessageType;
  content: string | null;
  caption: string | null;
  media?: { mimetype?: string; fileName?: string };
}

/** Read the message body/type out of Baileys' nested message envelope. */
export function extractMessage(m: any): Extracted | null {
  // Unwrap common wrappers (ephemeral, view-once, documentWithCaption).
  let msg = m ?? {};
  msg =
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg.documentWithCaptionMessage?.message ??
    msg;

  if (typeof msg.conversation === 'string') {
    return { type: 'text', content: msg.conversation, caption: null };
  }
  if (msg.extendedTextMessage?.text != null) {
    return { type: 'text', content: msg.extendedTextMessage.text, caption: null };
  }
  if (msg.imageMessage) {
    return {
      type: 'image',
      content: null,
      caption: msg.imageMessage.caption ?? null,
      media: { mimetype: msg.imageMessage.mimetype },
    };
  }
  if (msg.videoMessage) {
    return {
      type: 'video',
      content: null,
      caption: msg.videoMessage.caption ?? null,
      media: { mimetype: msg.videoMessage.mimetype },
    };
  }
  if (msg.audioMessage) {
    return {
      type: 'audio',
      content: null,
      caption: null,
      media: { mimetype: msg.audioMessage.mimetype },
    };
  }
  if (msg.documentMessage) {
    return {
      type: 'document',
      content: null,
      caption: msg.documentMessage.caption ?? null,
      media: {
        mimetype: msg.documentMessage.mimetype,
        fileName: msg.documentMessage.fileName,
      },
    };
  }
  return null; // unsupported type (sticker, location, reaction, poll, …) — ignored
}

export type DownloadFn = (raw: any) => Promise<Buffer>;

/**
 * Handle one incoming message: store it, download any media, and fire the
 * inbound webhook. `raw` is the full Baileys message (needed for media download).
 */
export async function handleInbound(
  numberId: string,
  fromPhone: string,
  raw: any,
  download: DownloadFn,
  groupJid: string | null = null,
): Promise<void> {
  const extracted = extractMessage(raw?.message);
  if (!extracted) return; // nothing we store for this message type

  // Baileys can emit messages.upsert more than once for the same message.
  // Dedupe on the provider message id so we store it (and webhook) only once.
  const providerId: string | null = raw?.key?.id ?? null;
  if (providerId && getMessageByProviderId(providerId)) return;

  const contact = resolveContact(fromPhone);

  let mediaPath: string | null = null;
  if (extracted.media) {
    try {
      const buffer = await download(raw);
      mkdirSync(MEDIA_DIR, { recursive: true });
      const ext = extFor(extracted.media.mimetype, extracted.media.fileName);
      const filename = `${randomUUID()}${ext}`;
      await writeFile(resolve(MEDIA_DIR, filename), buffer);
      mediaPath = resolve(MEDIA_DIR, filename);
    } catch {
      // Media download can fail (expired media, network) — keep the message
      // record with no media_url rather than dropping the event entirely.
      mediaPath = null;
    }
  }

  // A group JID only resolves to a `group_id` if it's already been synced
  // (Broadcasts page); otherwise the message is still captured, just without
  // a link to a `groups` row.
  const group = groupJid ? getGroupByProviderId(numberId, groupJid) : undefined;

  const message = createInboundMessage({
    number_id: numberId,
    contact_id: contact.id,
    type: extracted.type,
    content: extracted.content,
    caption: extracted.caption,
    media_path: mediaPath,
    provider_message_id: raw?.key?.id ?? null,
    group_id: group?.id ?? null,
  });
  markContacted(contact.id);

  // STOP-style auto-block only applies to direct messages — saying "stop" in
  // a group chat isn't a personal opt-out signal from that sender.
  const isStop = !groupJid && isStopKeyword(extracted.content);
  // Consent auto-block (Milestone 5): an inbound STOP-style keyword withdraws
  // consent — block the contact so no further messages go out to them.
  if (isStop && contact.consent_status !== 'blocked') {
    setConsent(contact.id, 'blocked', 'inbound_stop');
  }
  emitInbound(message, isStop);

  // v3 M1: auto-reply bot. Direct (1:1) messages only, and never for an
  // opt-out/STOP message (that just blocked the contact — replying would be
  // wrong). Fire-and-forget: the runtime never throws, so inbound capture and
  // webhook delivery above are unaffected regardless of bot outcome.
  if (!groupJid && !isStop) {
    void runBotReply({
      numberId,
      fromPhone,
      contactId: contact.id,
      inboundMessageId: message.id,
      text: extracted.content,
    });
  }
}

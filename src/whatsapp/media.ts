import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Button } from '../db/buttons.js';
import type { Message, MessageType } from '../db/messages.js';

// Same CJS-interop pattern as manager.ts — only `proto` is needed here, to
// build a raw buttonsMessage the friendly sendMessage() content API can't.
const require = createRequire(import.meta.url);
const { proto } = require('@whiskeysockets/baileys');

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
};

function guessMime(nameOrUrl: string, fallback: string): string {
  return MIME_BY_EXT[extname(nameOrUrl).toLowerCase()] ?? fallback;
}

/**
 * Build the Baileys `sendMessage` content object for a stored message.
 *
 * - text  → `{ text }`
 * - media by uploaded file → the raw bytes are read from disk into a Buffer.
 * - media by URL           → Baileys fetches it via `{ url }`.
 */
export async function buildContent(msg: Message, buttons: Button[] = []): Promise<Record<string, unknown>> {
  // Buttons + media are mutually exclusive in v2 (see milestone-log): a message
  // with buttons always sends as text + buttons, regardless of any media.
  if (buttons.length) {
    return buildButtonsContent(msg, buttons);
  }

  if (msg.type === 'text') {
    return { text: msg.content ?? '' };
  }

  // Resolve the media source: an uploaded file (bytes) or a remote URL.
  const source = msg.media_path
    ? await readFile(msg.media_path)
    : msg.media_url
      ? { url: msg.media_url }
      : null;
  if (!source) throw new Error('media_source_missing');

  const nameHint = msg.media_path ? basename(msg.media_path) : (msg.media_url ?? '');
  const caption = msg.caption ?? undefined;

  return mediaContent(msg.type, source, nameHint, caption);
}

/**
 * Builds a raw `buttonsMessage` proto (bypassing the friendly sendMessage()
 * content API, which has no path for buttons at all — see manager.ts's
 * relayRaw()). Text-only header (HeaderType.EMPTY = 1): media + buttons don't
 * combine in v2. Every button is sent as a classic RESPONSE (quick-reply)
 * button — the modern proto has no dedicated call/url button type; call/link
 * buttons carry their intended action in `payload` as metadata (visible to
 * API/webhook consumers) but render as a plain quick-reply on the device.
 */
function buildButtonsContent(msg: Message, buttons: Button[]): Record<string, unknown> {
  const contentText = msg.content ?? msg.caption ?? '';
  // Returns a fully-formed proto.Message instance (not a "friendly" content
  // shape) — relayRaw() passes this straight to sock.relayMessage(), bypassing
  // generateWAMessageContent entirely.
  return proto.Message.create({
    buttonsMessage: proto.Message.ButtonsMessage.create({
      contentText,
      headerType: 1, // EMPTY
      buttons: buttons.map((b) =>
        proto.Message.ButtonsMessage.Button.create({
          buttonId: b.id,
          buttonText: { displayText: b.label },
          type: 1, // RESPONSE
        }),
      ),
    }),
  });
}

function mediaContent(
  type: MessageType,
  source: Buffer | { url: string },
  nameHint: string,
  caption: string | undefined,
): Record<string, unknown> {
  switch (type) {
    case 'image':
      return { image: source, caption };
    case 'video':
      return { video: source, caption };
    case 'audio':
      return { audio: source, mimetype: guessMime(nameHint, 'audio/mpeg') };
    case 'document':
      return {
        document: source,
        mimetype: guessMime(nameHint, 'application/octet-stream'),
        fileName: basename(nameHint) || 'file',
        caption,
      };
    default:
      // Unreachable for well-formed input; treated as text upstream.
      return { text: caption ?? '' };
  }
}

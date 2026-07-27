import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Button } from '../db/buttons.js';
import type { Message, MessageType } from '../db/messages.js';

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
 * Renders buttons as a numbered text list appended to the message.
 *
 * A real raw `buttonsMessage` (via a low-level `sock.relayMessage`, bypassing
 * the friendly sendMessage() content API which has no button support at all)
 * was built and verified live against a real linked personal number: the send
 * succeeds and WhatsApp acknowledges it (a real message id, no error), but
 * nothing is ever delivered to the device — WhatsApp silently discards classic
 * interactive-button messages from non-Business-API personal numbers
 * server-side. So buttons render as plain text here instead, which actually
 * reaches the recipient.
 */
function buildButtonsContent(msg: Message, buttons: Button[]): Record<string, unknown> {
  const contentText = msg.content ?? msg.caption ?? '';
  const lines = buttons.map((b, i) => {
    const n = i + 1;
    if (b.type === 'call') return `${n}. ${b.label}${b.payload ? ` — call ${b.payload}` : ''}`;
    if (b.type === 'link') return `${n}. ${b.label}${b.payload ? ` — ${b.payload}` : ''}`;
    return `${n}. ${b.label}`;
  });
  return { text: `${contentText}\n\n${lines.join('\n')}` };
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

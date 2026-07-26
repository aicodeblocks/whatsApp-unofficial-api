import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
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
export async function buildContent(msg: Message): Promise<Record<string, unknown>> {
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

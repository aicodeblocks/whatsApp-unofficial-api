import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import {
  getJobByMessage,
  getMessage,
  jobCountsForNumber,
  jobsForNumber,
  listMessages,
  type MessageType,
} from '../../db/messages.js';
import { getNumber, setQueuePaused } from '../../db/numbers.js';
import { enqueueMessage, EnqueueError, type EnqueueInput } from '../../whatsapp/enqueue.js';

const MEDIA_DIR = resolve(config.dataDir, 'media');

/** Content-type by file extension for serving stored media. */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

const messageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    number_id: { type: 'string' },
    contact_id: { type: 'string' },
    direction: { type: 'string' },
    type: { type: 'string' },
    content: { type: ['string', 'null'] },
    caption: { type: ['string', 'null'] },
    media_url: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['queued', 'sent', 'delivered', 'read', 'failed'] },
    provider_message_id: { type: ['string', 'null'] },
    failure_reason: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    sent_at: { type: ['string', 'null'] },
    updated_at: { type: 'string' },
  },
} as const;

/** Public shape of a message (media_path is internal and never exposed). */
function toMessageView(id: string) {
  const m = getMessage(id);
  if (!m) return null;
  const { media_path: _mp, ...rest } = m;
  return rest;
}

/**
 * The send API. Every send is enqueued and paced by the anti-ban engine; the
 * call returns immediately with a message id and a "queued" status that then
 * advances to sent → delivered → read (or failed).
 */
export async function messageApiRoutes(app: FastifyInstance): Promise<void> {
  // Send a message (text, or media by URL). JSON body.
  app.post<{ Body: EnqueueInput }>(
    '/api/v1/messages',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'Send a message',
        description:
          'Enqueues an outbound message routed through the anti-ban pacing engine. Returns immediately with a message id and status "queued". Use media_url for media by link, or POST multipart to /api/v1/messages/upload to send an uploaded file. Set schedule_at (ISO-8601) for a future send.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['number_id', 'to', 'type'],
          properties: {
            number_id: { type: 'string', description: 'Id of the linked number to send from.' },
            to: { type: 'string', description: 'Recipient phone in international format (digits).' },
            type: { type: 'string', enum: ['text', 'image', 'document', 'audio', 'video'] },
            content: { type: 'string', description: 'Text body (for type=text).' },
            caption: { type: 'string', description: 'Caption (for media types).' },
            media_url: { type: 'string', description: 'URL the service fetches (for media types).' },
            schedule_at: { type: 'string', description: 'ISO-8601 time for a future send (optional).' },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              message_id: { type: 'string' },
              status: { type: 'string' },
              scheduled: { type: 'boolean' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      try {
        const msg = enqueueMessage(req.body);
        const job = getJobByMessage(msg.id);
        const scheduled = !!job && Date.parse(job.scheduled_send_at) > Date.now() + 1000;
        return reply.code(202).send({ message_id: msg.id, status: 'queued', scheduled });
      } catch (err) {
        if (err instanceof EnqueueError) return reply.code(400).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  // Send an uploaded media file (multipart/form-data).
  app.post(
    '/api/v1/messages/upload',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'Send a media message from an uploaded file',
        description:
          'multipart/form-data: fields number_id, to, type (image|document|audio|video), optional caption and schedule_at, plus a file part named "file". The file is stored and sent through the queue.',
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        response: {
          202: { type: 'object', properties: { message_id: { type: 'string' }, status: { type: 'string' }, scheduled: { type: 'boolean' } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: 'not_multipart', message: 'Send multipart/form-data.' });
      }
      const fields: Record<string, string> = {};
      let mediaPath: string | null = null;

      mkdirSync(MEDIA_DIR, { recursive: true });
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const ext = extname(part.filename ?? '') || '';
          mediaPath = resolve(MEDIA_DIR, `${randomUUID()}${ext}`);
          await writeFile(mediaPath, await part.toBuffer());
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }

      try {
        const msg = enqueueMessage({
          number_id: fields.number_id,
          to: fields.to,
          type: (fields.type as MessageType) ?? 'document',
          caption: fields.caption ?? null,
          media_path: mediaPath,
          schedule_at: fields.schedule_at ?? null,
        });
        const job = getJobByMessage(msg.id);
        const scheduled = !!job && Date.parse(job.scheduled_send_at) > Date.now() + 1000;
        return reply.code(202).send({ message_id: msg.id, status: 'queued', scheduled });
      } catch (err) {
        if (err instanceof EnqueueError) return reply.code(400).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  // Fetch a single message's status.
  app.get<{ Params: { id: string } }>(
    '/api/v1/messages/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'Get a message',
        description: 'Returns a message and its current status (queued/sent/delivered/read/failed).',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: messageSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const view = toMessageView(req.params.id);
      if (!view) return reply.code(404).send({ error: 'not_found' });
      return view;
    },
  );

  // Download a message's stored media (inbound or uploaded). Referenced by the
  // media_url in inbound webhook payloads.
  app.get<{ Params: { id: string } }>(
    '/api/v1/messages/:id/media',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'Download a message’s media',
        description:
          'Streams the stored media file for a message (e.g. an inbound image/document). Inbound webhook payloads point here via media_url. Requires a Bearer token.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const m = getMessage(req.params.id);
      if (!m || !m.media_path) return reply.code(404).send({ error: 'no_media' });
      // Confine to the media dir defensively (paths are app-generated UUIDs).
      const path = resolve(MEDIA_DIR, basename(m.media_path));
      if (!existsSync(path)) return reply.code(404).send({ error: 'file_missing' });
      const ext = extname(path).toLowerCase();
      reply.header('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
      return reply.send(createReadStream(path));
    },
  );

  // Recent messages, optionally filtered by number.
  app.get<{ Querystring: { number_id?: string; limit?: number } }>(
    '/api/v1/messages',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'List recent messages',
        description: 'Returns recent outbound messages, most recent first. Filter with number_id.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: { number_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
        },
        response: { 200: { type: 'object', properties: { messages: { type: 'array', items: messageSchema } } } },
      },
    },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const rows = listMessages(limit, req.query.number_id);
      return { messages: rows.map(({ media_path: _mp, ...r }) => r) };
    },
  );

  // Queue snapshot for a number.
  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/queue',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['messages'],
        summary: 'Get a number’s queue',
        description: 'Returns per-state counts, paused flag, and the pending/failed jobs for a number.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const number = getNumber(req.params.id);
      if (!number) return reply.code(404).send({ error: 'not_found' });
      return {
        paused: !!number.queue_paused,
        counts: jobCountsForNumber(number.id),
        jobs: jobsForNumber(number.id),
      };
    },
  );

  // Pause / resume a number's queue.
  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/numbers/:id/${action}`,
      {
        preHandler: app.requireApiToken,
        schema: {
          tags: ['messages'],
          summary: `${action === 'pause' ? 'Pause' : 'Resume'} a number’s queue`,
          description: `${action === 'pause' ? 'Stops releasing' : 'Resumes releasing'} queued messages for this number. Queued messages are retained either way.`,
          security: [{ bearerAuth: [] }],
          params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          response: {
            200: { type: 'object', properties: { id: { type: 'string' }, paused: { type: 'boolean' } } },
            404: { type: 'object', properties: { error: { type: 'string' } } },
          },
        },
      },
      async (req, reply) => {
        if (!getNumber(req.params.id)) return reply.code(404).send({ error: 'not_found' });
        setQueuePaused(req.params.id, action === 'pause');
        return { id: req.params.id, paused: action === 'pause' };
      },
    );
  }
}

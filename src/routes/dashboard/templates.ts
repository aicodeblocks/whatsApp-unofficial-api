import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import type { ButtonType } from '../../db/buttons.js';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate, type TemplateMediaType } from '../../db/templates.js';

const MEDIA_TYPES: TemplateMediaType[] = ['image', 'document', 'audio', 'video'];

const MEDIA_DIR = resolve(config.dataDir, 'media');
const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/** Collects up to 3 indexed button_type_N/button_label_N/button_payload_N fields
 *  from a multipart form into a buttons array. */
function collectButtons(fields: Record<string, string>): { type: ButtonType; label: string; payload: string | null }[] {
  const out: { type: ButtonType; label: string; payload: string | null }[] = [];
  for (let i = 0; i < 3; i++) {
    const type = fields[`button_type_${i}`] as ButtonType | undefined;
    const label = fields[`button_label_${i}`]?.trim();
    if (!type || !BUTTON_TYPES.includes(type) || !label) continue;
    out.push({ type, label, payload: fields[`button_payload_${i}`]?.trim() || null });
  }
  return out;
}

/** Parses a multipart request into plain fields + an optional uploaded file's saved path. */
async function parseMultipart(req: { isMultipart(): boolean; parts(): AsyncIterableIterator<any> }): Promise<{ fields: Record<string, string>; mediaPath: string | null }> {
  const fields: Record<string, string> = {};
  let mediaPath: string | null = null;
  if (!req.isMultipart()) return { fields, mediaPath };
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (part.filename) {
        mkdirSync(MEDIA_DIR, { recursive: true });
        const ext = extname(part.filename) || '';
        const dest = resolve(MEDIA_DIR, `${randomUUID()}${ext}`);
        await writeFile(dest, await part.toBuffer());
        mediaPath = dest;
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { fields, mediaPath };
}

/** Template library: create/edit/delete named templates with placeholders, optional media, and buttons. */
export async function templateDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { edit?: string } }>(
    '/templates',
    { preHandler: app.requireAdmin, ...dash('Templates page', 'HTML list of message templates with a create/edit form.') },
    async (req, reply) => {
      const editing = req.query.edit ? getTemplate(req.query.edit) : null;
      return reply.view('templates', { active: 'templates', templates: listTemplates(), editing: editing ?? null });
    },
  );

  app.post(
    '/templates',
    { preHandler: app.requireAdmin, ...dash('Create a template', 'multipart/form-data: name, category, body, optional file or media_url, button_type_N/button_label_N/button_payload_N (N=0..2).') },
    async (req, reply) => {
      const { fields, mediaPath } = await parseMultipart(req);
      createTemplate({
        name: (fields.name ?? '').trim() || 'Untitled template',
        category: fields.category?.trim() || null,
        body: fields.body ?? '',
        media_path: mediaPath,
        media_url: mediaPath ? null : fields.media_url?.trim() || null,
        media_type: MEDIA_TYPES.includes(fields.media_type as TemplateMediaType) ? (fields.media_type as TemplateMediaType) : 'document',
        buttons: collectButtons(fields),
      });
      return reply.redirect('/templates');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: app.requireAdmin, ...dash('Update a template', 'Same fields as create.') },
    async (req, reply) => {
      const { fields, mediaPath } = await parseMultipart(req);
      const existing = getTemplate(req.params.id);
      if (existing) {
        updateTemplate(req.params.id, {
          name: (fields.name ?? '').trim() || existing.name,
          category: fields.category?.trim() || null,
          body: fields.body ?? '',
          media_path: mediaPath ?? existing.media_path,
          media_url: mediaPath ? null : fields.media_url?.trim() || existing.media_url,
          media_type: MEDIA_TYPES.includes(fields.media_type as TemplateMediaType) ? (fields.media_type as TemplateMediaType) : existing.media_type,
          buttons: collectButtons(fields),
        });
      }
      return reply.redirect('/templates');
    },
  );

  app.post<{ Params: { id: string } }>(
    '/templates/:id/delete',
    { preHandler: app.requireAdmin, ...dash('Delete a template', '') },
    async (req, reply) => {
      deleteTemplate(req.params.id);
      return reply.redirect('/templates');
    },
  );
}

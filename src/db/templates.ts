import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import { type Button, type ButtonInput, getButtonsFor, setButtonsFor } from './buttons.js';
import type { MessageType } from './messages.js';

export type TemplateMediaType = Exclude<MessageType, 'text'>;

export interface Template {
  id: string;
  name: string;
  category: string | null;
  body: string;
  media_path: string | null;
  media_url: string | null;
  media_type: TemplateMediaType;
  created_at: string;
  updated_at: string;
}

export interface TemplateWithButtons extends Template {
  buttons: Button[];
}

export interface NewTemplate {
  name: string;
  category?: string | null;
  body: string;
  media_path?: string | null;
  media_url?: string | null;
  media_type?: TemplateMediaType;
  buttons?: ButtonInput[];
}

const insertStmt = db.prepare(`
  INSERT INTO templates (id, name, category, body, media_path, media_url, media_type, created_at, updated_at)
  VALUES (@id, @name, @category, @body, @media_path, @media_url, @media_type, @now, @now)
`);
const getStmt = db.prepare('SELECT * FROM templates WHERE id = ?');
const listStmt = db.prepare('SELECT * FROM templates ORDER BY created_at DESC');
const updateStmt = db.prepare(`
  UPDATE templates
     SET name = @name, category = @category, body = @body,
         media_path = @media_path, media_url = @media_url, media_type = @media_type, updated_at = @now
   WHERE id = @id
`);
const deleteStmt = db.prepare('DELETE FROM templates WHERE id = ?');

export function createTemplate(t: NewTemplate): TemplateWithButtons {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt.run({
    id,
    name: t.name,
    category: t.category ?? null,
    body: t.body,
    media_path: t.media_path ?? null,
    media_url: t.media_url ?? null,
    media_type: t.media_type ?? 'document',
    now,
  });
  if (t.buttons?.length) setButtonsFor('template', id, t.buttons);
  return getTemplate(id)!;
}

export function getTemplate(id: string): TemplateWithButtons | undefined {
  const row = getStmt.get(id) as Template | undefined;
  if (!row) return undefined;
  return { ...row, buttons: getButtonsFor('template', id) };
}

export function listTemplates(): TemplateWithButtons[] {
  const rows = listStmt.all() as Template[];
  return rows.map((row) => ({ ...row, buttons: getButtonsFor('template', row.id) }));
}

export interface UpdateTemplate {
  name: string;
  category?: string | null;
  body: string;
  media_path?: string | null;
  media_url?: string | null;
  media_type?: TemplateMediaType;
  buttons?: ButtonInput[];
}

export function updateTemplate(id: string, t: UpdateTemplate): TemplateWithButtons | undefined {
  const existing = getStmt.get(id) as Template | undefined;
  if (!existing) return undefined;
  updateStmt.run({
    id,
    name: t.name,
    category: t.category ?? null,
    body: t.body,
    media_path: t.media_path ?? null,
    media_url: t.media_url ?? null,
    media_type: t.media_type ?? existing.media_type,
    now: new Date().toISOString(),
  });
  setButtonsFor('template', id, t.buttons ?? []);
  return getTemplate(id);
}

export function deleteTemplate(id: string): boolean {
  return deleteStmt.run(id).changes > 0;
}

/** Substitutes {{name}} / {{phone}} — the only fields the Contact model has. */
export function fillPlaceholders(body: string, fields: { name?: string | null; phone?: string | null }): string {
  return body
    .replace(/\{\{\s*name\s*\}\}/gi, fields.name ?? fields.phone ?? '')
    .replace(/\{\{\s*phone\s*\}\}/gi, fields.phone ?? '');
}

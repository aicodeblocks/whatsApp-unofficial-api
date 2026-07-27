import type { FastifyInstance } from 'fastify';
import {
  addContactToList,
  contactIdsInList,
  createList,
  findOrCreateList,
  getList,
  listLists,
  listsForContact,
  recordImport,
  removeContactFromList,
} from '../../db/contact-lists.js';
import { getContact, getContactByPhone, listContacts, resolveContact, setConsent, updateContactName, type ConsentStatus } from '../../db/contacts.js';
import { normalizePhone } from '../../whatsapp/enqueue.js';
import { detectColumns, parseCsv } from '../../lib/csv.js';
import { humanInTz } from '../../time.js';

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

const VALID: ConsentStatus[] = ['opted_in', 'unknown', 'blocked'];

/** Maps a free-text consent cell from a CSV to our enum; anything unrecognized → unknown. */
function parseConsentCell(raw: string | undefined): ConsentStatus {
  const v = (raw ?? '').trim().toLowerCase();
  if (['opted_in', 'opted-in', 'opt_in', 'yes', 'true', '1'].includes(v)) return 'opted_in';
  if (['blocked', 'block', 'no', 'false', '0', 'stop'].includes(v)) return 'blocked';
  return 'unknown';
}

interface PreviewRow {
  row: number;
  phone: string;
  name: string;
  consent: ConsentStatus;
  problem: string | null; // null = valid
}

/** Parses+validates a CSV buffer against the existing contacts table, without writing anything. */
function buildPreview(csvText: string): { rows: PreviewRow[]; hasHeader: boolean } {
  const parsed = parseCsv(csvText);
  const cols = detectColumns(parsed);
  const dataRows = cols.hasHeader ? parsed.slice(1) : parsed;
  const seenPhones = new Set<string>();

  const rows: PreviewRow[] = dataRows.map((cells, i) => {
    const rawPhone = cells[cols.phoneIdx] ?? '';
    const name = cols.nameIdx != null ? (cells[cols.nameIdx] ?? '').trim() : '';
    const consent = cols.consentIdx != null ? parseConsentCell(cells[cols.consentIdx]) : 'unknown';

    let phone = '';
    let problem: string | null = null;
    try {
      phone = normalizePhone(rawPhone);
    } catch {
      problem = 'invalid phone';
    }
    if (!problem) {
      if (seenPhones.has(phone)) problem = 'duplicate in file';
      else if (getContactByPhone(phone)) problem = 'already a contact';
    }
    if (!problem) seenPhones.add(phone);

    return { row: i + 1, phone: phone || rawPhone, name, consent, problem };
  });

  return { rows, hasHeader: cols.hasHeader };
}

/** Dashboard pages for viewing contacts, managing consent/lists, and CSV import. */
export async function contactDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { search?: string; status?: ConsentStatus; list?: string } }>(
    '/contacts',
    { preHandler: app.requireAdmin, ...dash('Contacts page', 'Searchable contacts list with consent management, lists, and CSV import.') },
    async (req, reply) => {
      const status = VALID.includes(req.query.status as ConsentStatus) ? (req.query.status as ConsentStatus) : undefined;
      const lists = listLists();
      const listFilter = req.query.list && lists.some((l) => l.id === req.query.list) ? req.query.list : undefined;
      const memberIds = listFilter ? new Set(contactIdsInList(listFilter)) : null;

      let contacts = listContacts(req.query.search, status, 200);
      if (memberIds) contacts = contacts.filter((c) => memberIds.has(c.id));

      const view = contacts.map((c) => ({
        ...c,
        last_contacted_human: humanInTz(c.last_contacted_at),
        lists: listsForContact(c.id),
      }));

      return reply.view('contacts', {
        active: 'contacts',
        contacts: view,
        lists,
        search: req.query.search ?? '',
        status: status ?? '',
        listFilter: listFilter ?? '',
        importPreview: null,
        importSummary: null,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { consent_status?: ConsentStatus; source?: string } }>(
    '/contacts/:id/consent',
    { preHandler: app.requireAdmin, ...dash('Set consent (UI)', 'Marks a contact opted-in / blocked / unknown from the dashboard.') },
    async (req, reply) => {
      const existing = getContact(req.params.id);
      const status = req.body.consent_status;
      if (existing && status && VALID.includes(status)) {
        setConsent(existing.id, status, req.body.source || 'dashboard');
      }
      return reply.redirect('/contacts');
    },
  );

  // ---- Lists -----------------------------------------------------------------

  app.post<{ Body: { name?: string; description?: string } }>(
    '/contacts/lists',
    { preHandler: app.requireAdmin, ...dash('Create a contact list', 'Creates a named list/segment. Body: name, description (form-encoded).') },
    async (req, reply) => {
      const name = (req.body.name ?? '').trim();
      if (name) createList(name, req.body.description?.trim() || null);
      return reply.redirect('/contacts');
    },
  );

  app.post<{ Params: { id: string }; Body: { list_id?: string } }>(
    '/contacts/:id/lists',
    { preHandler: app.requireAdmin, ...dash('Add contact to a list', 'Body: list_id (form-encoded).') },
    async (req, reply) => {
      const contact = getContact(req.params.id);
      const list = req.body.list_id ? getList(req.body.list_id) : undefined;
      if (contact && list) addContactToList(list.id, contact.id);
      return reply.redirect('/contacts');
    },
  );

  app.post<{ Params: { id: string; listId: string } }>(
    '/contacts/:id/lists/:listId/remove',
    { preHandler: app.requireAdmin, ...dash('Remove contact from a list', '') },
    async (req, reply) => {
      removeContactFromList(req.params.listId, req.params.id);
      return reply.redirect('/contacts');
    },
  );

  // ---- CSV import: upload+preview, then confirm -------------------------------

  app.post(
    '/contacts/import',
    {
      preHandler: app.requireAdmin,
      ...dash('Preview a CSV contact import', 'multipart/form-data: file, optional list_id or new_list_name. Parses+validates without writing.'),
    },
    async (req, reply) => {
      if (!req.isMultipart()) return reply.code(400).send({ error: 'not_multipart' });
      let fileName = 'contacts.csv';
      let csvText = '';
      let listId = '';
      let newListName = '';
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          fileName = part.filename ?? fileName;
          csvText = (await part.toBuffer()).toString('utf8');
        } else if (part.fieldname === 'list_id') {
          listId = String(part.value);
        } else if (part.fieldname === 'new_list_name') {
          newListName = String(part.value);
        }
      }

      const { rows, hasHeader } = buildPreview(csvText);
      const lists = listLists();
      return reply.view('contacts', {
        active: 'contacts',
        contacts: listContacts(undefined, undefined, 200).map((c) => ({ ...c, last_contacted_human: humanInTz(c.last_contacted_at), lists: listsForContact(c.id) })),
        lists,
        search: '',
        status: '',
        listFilter: '',
        importPreview: {
          fileName,
          hasHeader,
          rows,
          validCount: rows.filter((r) => !r.problem).length,
          invalidCount: rows.filter((r) => r.problem).length,
          listId,
          newListName,
          rowsJson: JSON.stringify(rows.filter((r) => !r.problem)),
        },
        importSummary: null,
      });
    },
  );

  app.post<{ Body: { rows_json?: string; file_name?: string; list_id?: string; new_list_name?: string } }>(
    '/contacts/import/confirm',
    { preHandler: app.requireAdmin, ...dash('Confirm a CSV contact import', 'Inserts the previously-previewed valid rows into the target list.') },
    async (req, reply) => {
      let rows: PreviewRow[] = [];
      try {
        rows = JSON.parse(req.body.rows_json ?? '[]');
      } catch {
        rows = [];
      }

      const targetList = req.body.list_id
        ? getList(req.body.list_id)
        : req.body.new_list_name?.trim()
          ? findOrCreateList(req.body.new_list_name.trim())
          : undefined;

      let imported = 0;
      if (targetList) {
        for (const r of rows) {
          const contact = resolveContact(r.phone);
          if (r.name) updateContactName(contact.id, r.name);
          if (r.consent && r.consent !== 'unknown') setConsent(contact.id, r.consent, 'csv_import');
          addContactToList(targetList.id, contact.id);
          imported++;
        }
      }

      recordImport({
        file_name: req.body.file_name || 'contacts.csv',
        list_id: targetList?.id ?? '',
        total_rows: rows.length,
        imported_count: imported,
        skipped_count: 0,
        invalid_count: 0,
        status: 'completed',
      });

      const lists = listLists();
      return reply.view('contacts', {
        active: 'contacts',
        contacts: listContacts(undefined, undefined, 200).map((c) => ({ ...c, last_contacted_human: humanInTz(c.last_contacted_at), lists: listsForContact(c.id) })),
        lists,
        search: '',
        status: '',
        listFilter: targetList?.id ?? '',
        importPreview: null,
        importSummary: { imported, listName: targetList?.name ?? '(none)' },
      });
    },
  );
}

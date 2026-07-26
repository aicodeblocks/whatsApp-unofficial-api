import type { FastifyInstance } from 'fastify';
import { getContact, listContacts, setConsent, type ConsentStatus } from '../../db/contacts.js';
import { humanInTz } from '../../time.js';

const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

const VALID: ConsentStatus[] = ['opted_in', 'unknown', 'blocked'];

/** Dashboard pages for viewing contacts and managing their consent. */
export async function contactDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { search?: string; status?: ConsentStatus } }>(
    '/contacts',
    { preHandler: app.requireAdmin, ...dash('Contacts page', 'Searchable contacts list with consent management (opt-in / block).') },
    async (req, reply) => {
      const status = VALID.includes(req.query.status as ConsentStatus) ? (req.query.status as ConsentStatus) : undefined;
      const contacts = listContacts(req.query.search, status, 200).map((c) => ({
        ...c,
        last_contacted_human: humanInTz(c.last_contacted_at),
      }));
      return reply.view('contacts', {
        active: 'contacts',
        contacts,
        search: req.query.search ?? '',
        status: status ?? '',
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
}

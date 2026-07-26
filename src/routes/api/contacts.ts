import type { FastifyInstance } from 'fastify';
import {
  getContact,
  listContacts,
  setConsent,
  setConsentByPhone,
  type ConsentStatus,
} from '../../db/contacts.js';
import { isoInTz } from '../../time.js';
import { config } from '../../config.js';

const CONSENT_VALUES: ConsentStatus[] = ['opted_in', 'unknown', 'blocked'];

const contactSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    phone_number: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    consent_status: { type: 'string', enum: ['opted_in', 'unknown', 'blocked'] },
    consent_source: { type: ['string', 'null'] },
    first_contacted_at: { type: ['string', 'null'] },
    last_contacted_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    created_at_local: { type: ['string', 'null'] },
    timezone: { type: 'string' },
  },
} as const;

function view(c: ReturnType<typeof getContact>) {
  if (!c) return null;
  return { ...c, created_at_local: isoInTz(c.created_at), timezone: config.displayTz };
}

/**
 * Consent / contacts API (Milestone 5). Downstream apps use this to record who
 * has opted in or been blocked so WaGuard never messages a blocked recipient.
 */
export async function contactApiRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { search?: string; status?: ConsentStatus; limit?: number } }>(
    '/api/v1/contacts',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['contacts'],
        summary: 'List / search contacts',
        description:
          'Returns contacts (recipients) newest first, with their consent status. Filter with search (phone or name) and/or status=opted_in|unknown|blocked.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Substring match on phone number or display name.' },
            status: { type: 'string', enum: ['opted_in', 'unknown', 'blocked'] },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
        response: { 200: { type: 'object', properties: { contacts: { type: 'array', items: contactSchema } } } },
      },
    },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const rows = listContacts(req.query.search, req.query.status, limit);
      return { contacts: rows.map((c) => view(c)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/contacts/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['contacts'],
        summary: 'Get a contact',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: { 200: contactSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const c = view(getContact(req.params.id));
      if (!c) return reply.code(404).send({ error: 'not_found' });
      return c;
    },
  );

  // Set consent by phone number (upserts a contact if needed). This is the main
  // way a downstream app records an opt-in or a manual block.
  app.post<{ Body: { phone?: string; consent_status?: ConsentStatus; source?: string } }>(
    '/api/v1/contacts/consent',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['contacts'],
        summary: 'Set a contact’s consent (by phone)',
        description:
          'Marks a recipient opted_in or blocked (or unknown) with a recorded source. Creates the contact if it does not exist. Blocked recipients are never messaged.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['phone', 'consent_status'],
          properties: {
            phone: { type: 'string', description: 'Recipient phone in international format (digits).' },
            consent_status: { type: 'string', enum: ['opted_in', 'unknown', 'blocked'] },
            source: { type: 'string', description: 'Where the consent/block came from (e.g. "web_form", "manual").' },
          },
        },
        response: {
          200: contactSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const phone = (req.body.phone ?? '').replace(/[^0-9]/g, '');
      const status = req.body.consent_status;
      if (phone.length < 8 || phone.length > 15) {
        return reply.code(400).send({ error: 'invalid_phone', message: 'phone must be 8–15 digits.' });
      }
      if (!status || !CONSENT_VALUES.includes(status)) {
        return reply.code(400).send({ error: 'invalid_status', message: `consent_status must be one of: ${CONSENT_VALUES.join(', ')}.` });
      }
      const c = setConsentByPhone(phone, status, req.body.source ?? 'api');
      return view(c);
    },
  );

  // Set consent for a known contact id.
  app.post<{ Params: { id: string }; Body: { consent_status?: ConsentStatus; source?: string } }>(
    '/api/v1/contacts/:id/consent',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['contacts'],
        summary: 'Set a contact’s consent (by id)',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['consent_status'],
          properties: {
            consent_status: { type: 'string', enum: ['opted_in', 'unknown', 'blocked'] },
            source: { type: 'string' },
          },
        },
        response: {
          200: contactSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const existing = getContact(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const status = req.body.consent_status;
      if (!status || !CONSENT_VALUES.includes(status)) {
        return reply.code(400).send({ error: 'invalid_status', message: `consent_status must be one of: ${CONSENT_VALUES.join(', ')}.` });
      }
      setConsent(existing.id, status, req.body.source ?? 'api');
      return view(getContact(existing.id));
    },
  );
}

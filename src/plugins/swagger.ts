import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

/**
 * Auto-generated OpenAPI documentation. The spec is built from the route
 * schemas so it never drifts from the real API. As later milestones add
 * endpoints (with schemas), they appear here automatically.
 *
 * - Interactive docs UI:   /docs
 * - Downloadable spec:     /openapi.json
 */
async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: `${config.appName} API`,
        description:
          'Self-hosted, headless WhatsApp API. Link your own number by QR and send/receive messages with anti-ban pacing. All API calls require a Bearer token created in the dashboard.\n\n' +
          '**Try it out:** click **Authorize**, paste an API token from the dashboard (API Tokens page), and use **Try it out** on any endpoint.\n\n' +
          '**Webhooks:** WaGuard also *pushes* events to your configured endpoint (Webhooks page). Requests are POSTed as JSON, signed with `X-WaGuard-Signature: sha256=<hmac>` (HMAC-SHA256 of the raw body using your endpoint secret). Every payload is the envelope `WebhookEnvelope` whose `data` is one of `WebhookMessageInbound`, `WebhookMessageStatus`, or `WebhookHealthEvent` (see Schemas below).',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'An API token created in the WaGuard dashboard.',
          },
        },
        schemas: {
          WebhookEnvelope: {
            type: 'object',
            description: 'Common envelope for every webhook POST. `event` names the type; `data` holds the type-specific payload.',
            properties: {
              event: { type: 'string', enum: ['message.inbound', 'message.status', 'health.event'] },
              timestamp: { type: 'string', description: 'UTC ISO-8601 time the event was queued.' },
              data: { type: 'object', description: 'One of WebhookMessageInbound / WebhookMessageStatus / WebhookHealthEvent.' },
            },
          },
          WebhookMessageInbound: {
            type: 'object',
            description: 'data payload for event "message.inbound" (a received message).',
            properties: {
              message_id: { type: 'string' },
              number_id: { type: 'string' },
              direction: { type: 'string', enum: ['inbound'] },
              from: { type: ['string', 'null'], description: 'Sender phone number.' },
              type: { type: 'string', enum: ['text', 'image', 'document', 'audio', 'video'] },
              content: { type: ['string', 'null'] },
              caption: { type: ['string', 'null'] },
              media_url: { type: ['string', 'null'], description: 'Authenticated download URL for any media (Bearer token required).' },
              is_stop: { type: 'boolean', description: 'True if the body is a STOP-style opt-out (auto-blocks the contact).' },
              provider_message_id: { type: ['string', 'null'] },
              received_at: { type: 'string', description: 'UTC ISO-8601.' },
              received_at_local: { type: ['string', 'null'] },
              timezone: { type: 'string' },
            },
          },
          WebhookMessageStatus: {
            type: 'object',
            description: 'data payload for event "message.status" (an outbound status transition).',
            properties: {
              message_id: { type: 'string' },
              number_id: { type: 'string' },
              direction: { type: 'string', enum: ['outbound'] },
              to: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['sent', 'delivered', 'read', 'failed'] },
              provider_message_id: { type: ['string', 'null'] },
              failure_reason: { type: ['string', 'null'] },
              updated_at: { type: 'string', description: 'UTC ISO-8601.' },
              updated_at_local: { type: ['string', 'null'] },
              timezone: { type: 'string' },
            },
          },
          WebhookHealthEvent: {
            type: 'object',
            description: 'data payload for event "health.event" (a number health signal / transition).',
            properties: {
              number_id: { type: 'string' },
              health_status: { type: 'string', enum: ['healthy', 'at_risk', 'flagged'] },
              event_type: { type: 'string', description: 'disconnect | relogin | delivery_drop | failure_spike | at_risk | cooloff | flagged | recovered | warmup_change' },
              severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
              notes: { type: ['string', 'null'] },
              snapshot: { type: ['object', 'null'], additionalProperties: true, description: 'Recent activity: volume, sent/failed counts, failure ratio, last send time.' },
              cooloff_until: { type: ['string', 'null'], description: 'Present when flagged — the number rests until this time; route sends elsewhere.' },
              cooloff_minutes: { type: 'integer' },
              recommend_switch_number: { type: 'boolean' },
              occurred_at: { type: 'string', description: 'UTC ISO-8601.' },
              occurred_at_local: { type: ['string', 'null'] },
              timezone: { type: 'string' },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'system', description: 'Service status and health. Bearer-token API.' },
        {
          name: 'numbers',
          description: 'Link and manage WhatsApp numbers over the API. Bearer-token API — this is what downstream systems (e.g. a CRM) call.',
        },
        {
          name: 'messages',
          description: 'Send messages and track their status. Every send is paced by the anti-ban queue. Bearer-token API.',
        },
        {
          name: 'contacts',
          description:
            'Recipients and their consent status (opted_in / unknown / blocked). Blocked contacts are never messaged; an inbound "STOP" auto-blocks. Bearer-token API.',
        },
        {
          name: 'health',
          description:
            'Live per-number health (healthy / at_risk / flagged), cool-off windows, and the danger-sign event timeline. At-risk numbers auto-slow; flagged numbers rest in a cool-off. Bearer-token API.',
        },
        {
          name: 'templates',
          description:
            'Reusable message content with {{placeholders}} and optional buttons. Buttons + media are mutually exclusive; a message with buttons always sends as text. Bearer-token API.',
        },
        {
          name: 'dashboard (internal)',
          description:
            'The built-in admin web UI (HTML pages, admin session-cookie auth). These are NOT for API clients — a downstream app authenticates with a Bearer token and uses the API groups above. Listed here for reference only.',
        },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      // Keep the entered token across page reloads and enable Try-it-out by default.
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });

  // Convenience alias so downstream systems can grab the raw spec to import.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}

export default fp(swaggerPlugin, { name: 'swagger' });

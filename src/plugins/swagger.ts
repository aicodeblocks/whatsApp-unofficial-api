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
          'Self-hosted, headless WhatsApp API. Link your own number by QR and send/receive messages with anti-ban pacing. All API calls require a Bearer token created in the dashboard.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'An API token created in the WaGuard dashboard.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [{ name: 'system', description: 'Service status and health.' }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Convenience alias so downstream systems can grab the raw spec to import.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}

export default fp(swaggerPlugin, { name: 'swagger' });

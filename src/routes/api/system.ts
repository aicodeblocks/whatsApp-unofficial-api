import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

/**
 * System endpoints under /api/v1. Every route here is protected by the API
 * token preHandler, so it doubles as the proof that authentication works and
 * as the first documented endpoint in the OpenAPI spec.
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/status',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['system'],
        summary: 'Service status',
        description: 'Returns basic service status. Requires a valid Bearer token.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              version: { type: 'string' },
              status: { type: 'string' },
              time: { type: 'string', format: 'date-time' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      service: config.appName,
      version: '0.1.0',
      status: 'ok',
      time: new Date().toISOString(),
    }),
  );
}

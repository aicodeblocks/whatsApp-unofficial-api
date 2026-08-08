import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import Fastify from 'fastify';
import { config } from './config.js';
import './db/index.js'; // side-effect: open DB + run migrations
import authPlugin from './plugins/auth.js';
import swaggerPlugin from './plugins/swagger.js';
import { analyticsApiRoutes } from './routes/api/analytics.js';
import { botApiRoutes } from './routes/api/bots.js';
import { broadcastApiRoutes } from './routes/api/broadcasts.js';
import { contactApiRoutes } from './routes/api/contacts.js';
import { groupApiRoutes } from './routes/api/groups.js';
import { healthApiRoutes } from './routes/api/health.js';
import { messageApiRoutes } from './routes/api/messages.js';
import { numberApiRoutes } from './routes/api/numbers.js';
import { systemRoutes } from './routes/api/system.js';
import { templateApiRoutes } from './routes/api/templates.js';
import { analyticsDashboardRoutes } from './routes/dashboard/analytics.js';
import { botsDashboardRoutes } from './routes/dashboard/bots.js';
import { broadcastsDashboardRoutes } from './routes/dashboard/broadcasts.js';
import { contactDashboardRoutes } from './routes/dashboard/contacts.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { healthDashboardRoutes } from './routes/dashboard/health.js';
import { numberDashboardRoutes } from './routes/dashboard/numbers.js';
import { portalRoutes } from './routes/dashboard/portal.js';
import { queueDashboardRoutes } from './routes/dashboard/queue.js';
import { templateDashboardRoutes } from './routes/dashboard/templates.js';
import { webhookDashboardRoutes } from './routes/dashboard/webhooks.js';
import { whatsappManager } from './whatsapp/manager.js';
import { startQueue } from './whatsapp/queue.js';
import { startWebhookWorker } from './whatsapp/webhooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // Form posts (login, setup, token create) and server-rendered views.
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  await app.register(fastifyView, {
    engine: { ejs },
    root: resolve(__dirname, 'views'),
    viewExt: 'ejs',
  });

  // Inject shared shell context into every server-rendered view so the branded
  // header/footer (@fastify/view merges `reply.locals` into the render context,
  // and EJS `include` inherits it) can show the linked-number indicator and app
  // version without every route handler having to pass them. Skipped for the API
  // and docs, which never render EJS views.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api') || url.startsWith('/openapi') || url.startsWith('/docs')) return;
    const numbers = whatsappManager.list();
    reply.locals = {
      ...reply.locals,
      appName: config.appName,
      appVersion: config.appVersion,
      numberCount: numbers.length,
      linkedCount: numbers.filter((n) => n.status === 'linked').length,
    };
  });

  // Auth (admin sessions + API-token bearer) and auto-generated API docs.
  await app.register(authPlugin);
  await app.register(swaggerPlugin);

  // Routes.
  await app.register(async (instance) => systemRoutes(instance));
  await app.register(async (instance) => numberApiRoutes(instance));
  await app.register(async (instance) => messageApiRoutes(instance));
  await app.register(async (instance) => contactApiRoutes(instance));
  await app.register(async (instance) => healthApiRoutes(instance));
  await app.register(async (instance) => templateApiRoutes(instance));
  await app.register(async (instance) => broadcastApiRoutes(instance));
  await app.register(async (instance) => groupApiRoutes(instance));
  await app.register(async (instance) => analyticsApiRoutes(instance));
  await app.register(async (instance) => botApiRoutes(instance));
  await app.register(async (instance) => dashboardRoutes(instance));
  await app.register(async (instance) => numberDashboardRoutes(instance));
  await app.register(async (instance) => queueDashboardRoutes(instance));
  await app.register(async (instance) => webhookDashboardRoutes(instance));
  await app.register(async (instance) => contactDashboardRoutes(instance));
  await app.register(async (instance) => healthDashboardRoutes(instance));
  await app.register(async (instance) => templateDashboardRoutes(instance));
  await app.register(async (instance) => botsDashboardRoutes(instance));
  await app.register(async (instance) => broadcastsDashboardRoutes(instance));
  await app.register(async (instance) => analyticsDashboardRoutes(instance));
  await app.register(async (instance) => portalRoutes(instance));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`${config.appName} listening on http://${config.host}:${config.port}`);
    app.log.info('Docs: /docs  ·  Spec: /openapi.json');

    // Reconnect any previously-linked numbers in the background.
    whatsappManager.init().catch((err) => app.log.error(err, 'whatsapp init failed'));

    // Start the anti-ban send queue worker (recovers any interrupted jobs).
    startQueue();

    // Start the webhook delivery/retry worker.
    startWebhookWorker();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();

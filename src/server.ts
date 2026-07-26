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
import { messageApiRoutes } from './routes/api/messages.js';
import { numberApiRoutes } from './routes/api/numbers.js';
import { systemRoutes } from './routes/api/system.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { numberDashboardRoutes } from './routes/dashboard/numbers.js';
import { queueDashboardRoutes } from './routes/dashboard/queue.js';
import { whatsappManager } from './whatsapp/manager.js';
import { startQueue } from './whatsapp/queue.js';

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

  // Auth (admin sessions + API-token bearer) and auto-generated API docs.
  await app.register(authPlugin);
  await app.register(swaggerPlugin);

  // Routes.
  await app.register(async (instance) => systemRoutes(instance));
  await app.register(async (instance) => numberApiRoutes(instance));
  await app.register(async (instance) => messageApiRoutes(instance));
  await app.register(async (instance) => dashboardRoutes(instance));
  await app.register(async (instance) => numberDashboardRoutes(instance));
  await app.register(async (instance) => queueDashboardRoutes(instance));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`${config.appName} listening on http://${config.host}:${config.port}`);
    app.log.info('Docs: /docs  ·  Spec: /openapi.json');

    // Reconnect any previously-linked numbers in the background.
    whatsappManager.init().catch((err) => app.log.error(err, 'whatsapp init failed'));

    // Start the anti-ban send queue worker (recovers any interrupted jobs).
    startQueue();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();

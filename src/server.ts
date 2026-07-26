import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import Fastify from 'fastify';
import { config } from './config.js';
import './db/index.js'; // side-effect: open DB + run migrations
import authPlugin from './plugins/auth.js';
import swaggerPlugin from './plugins/swagger.js';
import { systemRoutes } from './routes/api/system.js';
import { dashboardRoutes } from './routes/dashboard/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // Form posts (login, setup, token create) and server-rendered views.
  await app.register(fastifyFormbody);
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
  await app.register(async (instance) => dashboardRoutes(instance));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`${config.appName} listening on http://${config.host}:${config.port}`);
    app.log.info('Docs: /docs  ·  Spec: /openapi.json');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();

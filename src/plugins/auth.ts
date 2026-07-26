import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { verifyToken } from '../db/tokens.js';

declare module 'fastify' {
  interface Session {
    admin?: boolean;
  }
  interface FastifyInstance {
    /** preHandler: redirect to login/setup unless an admin session is active. */
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler: reject API calls that lack a valid Bearer token. */
    requireApiToken: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookieName: 'waguard.sid',
    cookie: {
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session.admin) {
      reply.redirect('/login');
    }
  });

  app.decorate('requireApiToken', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const raw = match?.[1]?.trim();
    if (!raw) {
      reply.code(401).send({ error: 'unauthorized', message: 'Missing Bearer token.' });
      return;
    }
    const token = verifyToken(raw);
    if (!token) {
      reply.code(401).send({ error: 'unauthorized', message: 'Invalid or revoked token.' });
      return;
    }
    (req as FastifyRequest & { apiToken?: unknown }).apiToken = token;
  });
}

export default fp(authPlugin, { name: 'auth' });

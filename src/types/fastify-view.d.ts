import '@fastify/view';

/**
 * @fastify/view decorates the reply with a mutable `locals` object that it
 * merges into every `reply.view(...)` render, but (as of v10) it does not
 * augment the FastifyReply type with it. We use it to inject the branded-shell
 * context (app name/version, linked-number count) into every server-rendered
 * page from a single onRequest hook, so declare it here.
 */
declare module 'fastify' {
  interface FastifyReply {
    locals?: Record<string, unknown>;
  }
}

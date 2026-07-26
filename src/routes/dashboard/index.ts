import type { FastifyInstance } from 'fastify';
import { isFirstRun, setAdminPassword, verifyAdminPassword } from '../../db/settings.js';
import { createToken, listTokens, revokeToken } from '../../db/tokens.js';
import { whatsappManager } from '../../whatsapp/manager.js';

interface PasswordBody {
  password?: string;
  confirm?: string;
}

/** Shared doc metadata so dashboard pages appear grouped (not under "default"). */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/**
 * Server-rendered admin dashboard. Intentionally minimal and dependency-light.
 * The API docs and API itself are the product; this UI just links numbers,
 * manages tokens, and (in later milestones) shows health, queue, and webhooks.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // ---- First-run setup -----------------------------------------------------
  app.get('/setup', dash('First-run setup page', 'HTML. Shown once to create the admin password; redirects to /login afterwards.'), async (req, reply) => {
    if (!isFirstRun()) return reply.redirect('/login');
    return reply.view('setup', { error: null });
  });

  app.post<{ Body: PasswordBody }>('/setup', dash('Submit first-run setup', 'Sets the admin password and starts a session. Body: password, confirm (form-encoded).'), async (req, reply) => {
    if (!isFirstRun()) return reply.redirect('/login');
    const { password, confirm } = req.body;
    if (!password || password.length < 8) {
      return reply.view('setup', { error: 'Password must be at least 8 characters.' });
    }
    if (password !== confirm) {
      return reply.view('setup', { error: 'Passwords do not match.' });
    }
    setAdminPassword(password);
    req.session.admin = true;
    return reply.redirect('/');
  });

  // ---- Login / logout ------------------------------------------------------
  app.get('/login', dash('Login page', 'HTML admin login form.'), async (req, reply) => {
    if (isFirstRun()) return reply.redirect('/setup');
    if (req.session.admin) return reply.redirect('/');
    return reply.view('login', { error: null });
  });

  app.post<{ Body: PasswordBody }>('/login', dash('Submit login', 'Verifies the admin password and starts a session. Body: password (form-encoded).'), async (req, reply) => {
    if (isFirstRun()) return reply.redirect('/setup');
    const { password } = req.body;
    if (!password || !verifyAdminPassword(password)) {
      return reply.view('login', { error: 'Incorrect password.' });
    }
    req.session.admin = true;
    return reply.redirect('/');
  });

  app.post('/logout', { preHandler: app.requireAdmin, ...dash('Log out', 'Destroys the admin session.') }, async (req, reply) => {
    await req.session.destroy();
    return reply.redirect('/login');
  });

  // ---- Home overview -------------------------------------------------------
  app.get('/', { preHandler: app.requireAdmin, ...dash('Dashboard home', 'HTML overview: number and token counts, links to docs.') }, async (_req, reply) => {
    const numbers = whatsappManager.list();
    return reply.view('home', {
      active: 'home',
      tokenCount: listTokens().filter((t) => t.active).length,
      numberCount: numbers.length,
      linkedCount: numbers.filter((n) => n.status === 'linked').length,
    });
  });

  // ---- API tokens ----------------------------------------------------------
  app.get('/tokens', { preHandler: app.requireAdmin, ...dash('API tokens page', 'HTML list of API tokens with create/revoke controls.') }, async (_req, reply) => {
    return reply.view('tokens', { active: 'tokens', tokens: listTokens(), newToken: null });
  });

  app.post<{ Body: { name?: string } }>(
    '/tokens',
    { preHandler: app.requireAdmin, ...dash('Create API token', 'Creates a token and shows its one-time value. Body: name (form-encoded).') },
    async (req, reply) => {
      const name = (req.body.name ?? '').trim() || 'Untitled token';
      const { token } = createToken(name);
      return reply.view('tokens', { active: 'tokens', tokens: listTokens(), newToken: token });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/tokens/:id/revoke',
    { preHandler: app.requireAdmin, ...dash('Revoke API token', 'Revokes the token with the given id.') },
    async (req, reply) => {
      revokeToken(req.params.id);
      return reply.redirect('/tokens');
    },
  );
}

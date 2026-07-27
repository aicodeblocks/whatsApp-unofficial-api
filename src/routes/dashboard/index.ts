import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { contactCounts } from '../../db/contacts.js';
import { listHealthEvents } from '../../db/health.js';
import { countMessages, jobCountsForNumber, listMessages } from '../../db/messages.js';
import { isFirstRun, setAdminPassword, verifyAdminPassword } from '../../db/settings.js';
import { createToken, listTokens, revokeToken } from '../../db/tokens.js';
import { getEndpoint, recentDeliveries } from '../../db/webhooks.js';
import { humanInTz } from '../../time.js';
import { whatsappManager } from '../../whatsapp/manager.js';

/** A single row in the Overview recent-activity feed. */
interface ActivityItem {
  kind: 'in' | 'out' | 'health' | 'hook';
  main: string;
  iso: string;
  time: string;
}

/** Short, human labels for the health event types shown in the activity feed. */
const HEALTH_LABELS: Record<string, string> = {
  disconnect: 'Connection dropped',
  relogin: 'Session logged out',
  delivery_drop: 'Delivery drop detected',
  failure_spike: 'Send-failure spike',
  at_risk: 'Number went at-risk',
  cooloff: 'Number placed in cool-off',
  flagged: 'Number flagged',
  recovered: 'Number recovered',
  warmup_change: 'Warm-up advanced',
};

/** Build the Overview page's live status, health strip, and activity feed. */
function buildOverview() {
  const numbers = whatsappManager.list();
  const linked = numbers.filter((n) => n.status === 'linked');
  const atRisk = numbers.filter((n) => n.health_status === 'at_risk');
  const flagged = numbers.filter((n) => n.health_status === 'flagged');
  const queueDepth = numbers.reduce((sum, n) => sum + jobCountsForNumber(n.id).waiting, 0);

  const inbound = countMessages('inbound');
  const outbound = countMessages('outbound');
  const contacts = contactCounts();

  const endpoint = getEndpoint();
  const deliveries = recentDeliveries(50);
  const failed = deliveries.filter((d) => d.status === 'failed').length;
  const pending = deliveries.filter((d) => d.status === 'pending').length;
  const succeeded = deliveries.filter((d) => d.status === 'success').length;

  // Status dots: active (green), idle (grey), attention (amber).
  const dot = (active: boolean, attention = false) =>
    attention ? 'attention' : active ? 'active' : 'idle';

  const webhookState = !endpoint || !endpoint.active
    ? { dot: 'idle', note: endpoint ? 'Endpoint disabled' : 'No endpoint configured' }
    : failed > 0
      ? { dot: 'attention', note: `${failed} recent failure${failed === 1 ? '' : 's'}` }
      : { dot: 'active', note: succeeded > 0 ? 'Delivering cleanly' : 'Endpoint ready' };

  const cards = [
    { key: 'numbers', title: 'Numbers', href: '/numbers', val: `${linked.length}`, unit: `/ ${numbers.length} linked`,
      note: numbers.length ? `${numbers.length} configured` : 'No numbers yet', dot: dot(linked.length > 0) },
    { key: 'queue', title: 'Send & Queue', href: '/queue', val: `${queueDepth}`, unit: 'queued',
      note: `${outbound} sent all-time`, dot: dot(queueDepth > 0) },
    { key: 'receiving', title: 'Receiving', href: '/queue', val: `${inbound}`, unit: 'received',
      note: 'Inbound messages captured', dot: dot(inbound > 0) },
    { key: 'webhooks', title: 'Webhooks', href: '/webhooks', val: `${succeeded}`, unit: 'delivered',
      note: webhookState.note, dot: webhookState.dot },
    { key: 'health', title: 'Health', href: '/health', val: `${atRisk.length + flagged.length}`, unit: 'need attention',
      note: flagged.length ? `${flagged.length} flagged` : atRisk.length ? `${atRisk.length} at-risk` : 'All healthy',
      dot: dot(numbers.length > 0 && atRisk.length + flagged.length === 0, atRisk.length + flagged.length > 0) },
    { key: 'contacts', title: 'Contacts', href: '/contacts', val: `${contacts.total}`, unit: 'contacts',
      note: `${contacts.opted_in} opted-in · ${contacts.blocked} blocked`, dot: dot(contacts.total > 0) },
  ];

  const strip = [
    { label: 'Numbers linked', val: `${linked.length}`, unit: `/ ${numbers.length}`, cls: '' },
    { label: 'Queue depth', val: `${queueDepth}`, unit: '', cls: '' },
    { label: 'At-risk numbers', val: `${atRisk.length + flagged.length}`, unit: '',
      cls: flagged.length ? 'bad' : atRisk.length ? 'attention' : '' },
    { label: 'Webhook health', val: failed > 0 ? `${failed}` : 'OK', unit: failed > 0 ? 'failing' : '',
      cls: failed > 0 ? 'attention' : '' },
  ];

  // Merge recent messages, health events, and webhook deliveries into one feed.
  const items: ActivityItem[] = [];
  for (const m of listMessages(8)) {
    const label = m.content ? m.content.replace(/\s+/g, ' ').slice(0, 60) : `[${m.type}]`;
    items.push({
      kind: m.direction === 'inbound' ? 'in' : 'out',
      main: `${m.direction === 'inbound' ? 'Received' : 'Sent'}: ${label}`,
      iso: m.created_at, time: humanInTz(m.created_at),
    });
  }
  for (const e of listHealthEvents(undefined, 8)) {
    items.push({ kind: 'health', main: HEALTH_LABELS[e.event_type] ?? e.event_type, iso: e.created_at, time: humanInTz(e.created_at) });
  }
  for (const d of recentDeliveries(8)) {
    const verb = d.status === 'success' ? 'delivered' : d.status === 'failed' ? 'failed' : 'pending';
    items.push({ kind: 'hook', main: `Webhook ${d.event_type} ${verb}`, iso: d.updated_at || d.created_at, time: humanInTz(d.updated_at || d.created_at) });
  }
  items.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));

  return { cards, strip, activity: items.slice(0, 10), pending };
}

interface PasswordBody {
  password?: string;
  confirm?: string;
}

/** Shared doc metadata so dashboard pages appear grouped (not under "default"). */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/**
 * The login image URL with a per-request cache-buster appended, so services
 * like picsum.photos return a fresh image on every page load instead of the
 * browser reusing a cached one. Empty config → no image.
 */
function loginImageUrl(): string | null {
  const base = config.loginImageUrl.trim();
  if (!base) return null;
  return base + (base.includes('?') ? '&' : '?') + '_cb=' + Date.now();
}

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
    return reply.view('login', { error: null, loginImage: loginImageUrl() });
  });

  app.post<{ Body: PasswordBody }>('/login', dash('Submit login', 'Verifies the admin password and starts a session. Body: password (form-encoded).'), async (req, reply) => {
    if (isFirstRun()) return reply.redirect('/setup');
    const { password } = req.body;
    if (!password || !verifyAdminPassword(password)) {
      return reply.view('login', { error: 'Incorrect password.', loginImage: loginImageUrl() });
    }
    req.session.admin = true;
    return reply.redirect('/');
  });

  app.post('/logout', { preHandler: app.requireAdmin, ...dash('Log out', 'Destroys the admin session.') }, async (req, reply) => {
    await req.session.destroy();
    return reply.redirect('/login');
  });

  // ---- Home overview -------------------------------------------------------
  app.get('/', { preHandler: app.requireAdmin, ...dash('Dashboard home', 'HTML overview: live status cards, system-health strip, and recent activity.') }, async (_req, reply) => {
    const overview = buildOverview();
    return reply.view('home', {
      active: 'home',
      tokenCount: listTokens().filter((t) => t.active).length,
      ...overview,
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

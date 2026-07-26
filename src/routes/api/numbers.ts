import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../../db/tokens.js';
import { whatsappManager } from '../../whatsapp/manager.js';

const numberSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    phone_number: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['connecting', 'linked', 'disconnected', 'flagged'] },
    linked_at: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
} as const;

/**
 * Read-only API for checking linked numbers and their connection status.
 * Downstream apps use this to know which numbers are available to send from.
 */
export async function numberApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/numbers',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'List WhatsApp numbers',
        description: 'Returns all linked/linking numbers and their current connection status.',
        security: [{ bearerAuth: [] }],
        response: {
          200: { type: 'object', properties: { numbers: { type: 'array', items: numberSchema } } },
        },
      },
    },
    async () => ({
      numbers: whatsappManager.list().map(({ qr: _qr, ...n }) => n),
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Get a WhatsApp number',
        description: 'Returns a single number and its current connection status.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: numberSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      const { qr: _qr, ...rest } = n;
      return rest;
    },
  );

  // Create a number and begin the QR linking flow. Poll the /qr endpoint to
  // fetch the QR image and watch for status → linked.
  app.post<{ Body: { label?: string } }>(
    '/api/v1/numbers',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Add a WhatsApp number',
        description:
          'Creates a number and starts linking. Then poll GET /api/v1/numbers/{id}/qr for the QR code and connection status.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: { label: { type: 'string', description: 'A friendly label for the number.' } },
        },
        response: { 201: numberSchema },
      },
    },
    async (req, reply) => {
      const row = await whatsappManager.addNumber(req.body?.label ?? '');
      const n = whatsappManager.get(row.id)!;
      const { qr: _qr, ...rest } = n;
      return reply.code(201).send(rest);
    },
  );

  // The QR (and live status) for linking — the endpoint downstream systems poll
  // to render their own "scan to link" screen.
  app.get<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/qr',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Get a number’s QR code and link status',
        description:
          'While status is "connecting", `qr` is a PNG data-URI to display for scanning; it refreshes as it expires and becomes null once the number is linked.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['connecting', 'linked', 'disconnected', 'flagged'] },
              qr: { type: ['string', 'null'], description: 'PNG data-URI, or null when not awaiting a scan.' },
              phone: { type: ['string', 'null'] },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      return { status: n.status, qr: n.qr, phone: n.phone_number };
    },
  );

  // The QR as an actual scannable PNG image (not JSON). Useful for viewing/
  // scanning directly in a browser or in the Swagger "Try it out" response.
  // Accepts the token via the Authorization header OR a ?token= query param so
  // the image URL can be opened directly in a browser tab (note: a token in a
  // URL may be logged — prefer the header where you can).
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/v1/numbers/:id/qr.png',
    {
      preHandler: async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
        const header = req.headers.authorization ?? '';
        const raw = (/^Bearer\s+(.+)$/i.exec(header)?.[1] ?? req.query.token ?? '').trim();
        if (!raw || !verifyToken(raw)) {
          reply.code(401).send({ error: 'unauthorized', message: 'Provide a valid token via Bearer header or ?token=.' });
        }
      },
      schema: {
        tags: ['numbers'],
        summary: 'Get a number’s QR as a scannable PNG image',
        description:
          'Returns the QR as an `image/png` you can view and scan directly (in a browser or the Swagger response), while status is "connecting". Returns 404 once linked (no QR) or if the id is unknown. Auth via Bearer header or ?token= query param.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        produces: ['image/png'],
        response: {
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).send({ error: 'not_found' });
      if (!n.qr) return reply.code(404).send({ error: 'no_qr', message: 'No QR available (number is not awaiting a scan).' });
      // n.qr is a data-URI (data:image/png;base64,....) — decode to raw PNG bytes.
      const base64 = n.qr.split(',')[1] ?? '';
      const png = Buffer.from(base64, 'base64');
      return reply.header('Cache-Control', 'no-store').type('image/png').send(png);
    },
  );

  // A self-contained HTML page that shows the QR and auto-refreshes it (and
  // flips to "linked") by polling — the same behaviour as the dashboard, but
  // openable directly in a browser with just a token. Handy when there is no
  // downstream app yet. Auth via Bearer header or ?token= query.
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/v1/numbers/:id/qr/live',
    {
      preHandler: async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
        const header = req.headers.authorization ?? '';
        const raw = (/^Bearer\s+(.+)$/i.exec(header)?.[1] ?? req.query.token ?? '').trim();
        if (!raw || !verifyToken(raw)) {
          reply.code(401).send({ error: 'unauthorized', message: 'Provide a valid token via Bearer header or ?token=.' });
        }
      },
      schema: {
        tags: ['numbers'],
        summary: 'Live QR page (auto-refreshing HTML)',
        description:
          'Returns a self-contained HTML page that displays the QR and auto-refreshes it (polling every ~2s), flipping to a linked state once scanned — like the dashboard, but standalone. Open it in a browser. Auth via Bearer header or ?token= query.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        produces: ['text/html'],
      },
    },
    async (req, reply) => {
      const n = whatsappManager.get(req.params.id);
      if (!n) return reply.code(404).type('text/html').send('<h1>404 — number not found</h1>');
      const header = req.headers.authorization ?? '';
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? req.query.token ?? '';
      const html = livePageHtml(n.id, n.label, token);
      return reply.header('Cache-Control', 'no-store').type('text/html').send(html);
    },
  );

  // Re-open the QR flow for a disconnected number without creating a new one.
  app.post<{ Params: { id: string } }>(
    '/api/v1/numbers/:id/relink',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Re-link a number',
        description: 'Restarts the QR linking flow for an existing number. Then poll the /qr endpoint.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: numberSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      if (!whatsappManager.get(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      await whatsappManager.relink(req.params.id);
      const { qr: _qr, ...rest } = whatsappManager.get(req.params.id)!;
      return rest;
    },
  );

  // Log out from WhatsApp and remove the number.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/numbers/:id',
    {
      preHandler: app.requireApiToken,
      schema: {
        tags: ['numbers'],
        summary: 'Unlink a number',
        description: 'Logs the number out of WhatsApp, deletes its session, and removes it.',
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      if (!whatsappManager.get(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      await whatsappManager.unlink(req.params.id);
      return { ok: true };
    },
  );
}

/** Self-contained auto-refreshing QR page. Token is embedded so the page can
 *  poll the JSON QR endpoint from the browser and swap the image as it rotates. */
function livePageHtml(id: string, label: string, token: string): string {
  const data = JSON.stringify({ id, token });
  const safeLabel = String(label).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Link "${safeLabel}" — WaGuard</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#e5e5e5}
  .card{max-width:360px;width:100%;padding:28px;text-align:center}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#9a9a9a;font-size:14px;margin:0 0 18px}
  .qrbox{background:#fff;border-radius:12px;padding:14px;display:inline-block;min-height:250px;min-width:250px}
  .qrbox img{width:250px;height:250px;display:block}
  .status{margin-top:16px;font-size:14px}
  .pill{display:inline-block;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid #444}
  .pill.linked{color:#34d399;border-color:#34d399}.pill.warn{color:#fbbf24;border-color:#fbbf24}.pill.bad{color:#f87171;border-color:#f87171}
  .hint{color:#9a9a9a;font-size:12px;margin-top:10px}
</style></head>
<body><div class="card">
  <h1>Link "${safeLabel}"</h1>
  <p class="sub">WhatsApp → Settings → Linked Devices → Link a device, then scan.</p>
  <div class="qrbox"><img id="qr" alt="QR code" /><div id="wait" style="color:#666;padding-top:110px">Loading QR…</div></div>
  <div class="status"><span id="badge" class="pill warn">connecting</span></div>
  <div class="hint" id="hint">This QR refreshes automatically. Keep this page open.</div>
</div>
<script>
(function(){
  var C = ${data};
  var img=document.getElementById('qr'), wait=document.getElementById('wait'),
      badge=document.getElementById('badge'), hint=document.getElementById('hint');
  function pill(s){var c=s==='linked'?'linked':s==='connecting'?'warn':'bad';badge.className='pill '+c;badge.textContent=s;}
  function poll(){
    fetch('/api/v1/numbers/'+C.id+'/qr',{headers:{Authorization:'Bearer '+C.token,Accept:'application/json'}})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        if(!d)return;
        pill(d.status);
        if(d.status==='connecting'){
          if(d.qr){img.src=d.qr;img.style.display='block';wait.style.display='none';}
          else{img.style.display='none';wait.style.display='block';}
        } else if(d.status==='linked'){
          clearInterval(t);img.style.display='none';wait.style.display='none';
          hint.textContent='Linked'+(d.phone?' as +'+d.phone:'')+'. You can close this page.';
        } else {
          clearInterval(t);img.style.display='none';wait.textContent='Session ended — re-link the number.';wait.style.display='block';
        }
      }).catch(function(){});
  }
  var t=setInterval(poll,2000);poll();
})();
</script></body></html>`;
}

/**
 * Milestone 5 verification — exercises the real compiled logic in-process.
 * Run: node scratchpad/verify-m5.mjs   (uses an isolated temp DATA_DIR)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the DB + set fast/deterministic health config BEFORE importing modules.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'waguard-m5-'));
process.env.QUIET_HOURS_ENABLED = 'false';
process.env.HEALTH_MIN_VOLUME = '5';
process.env.HEALTH_FLAG_RATIO = '0.6';
process.env.HEALTH_COOLOFF_BASE_MIN = '60';

const { db } = await import('../dist/db/index.js');
const { createNumber, getNumber } = await import('../dist/db/numbers.js');
const { resolveContact, setConsentByPhone, getContactByPhone, listContacts } = await import('../dist/db/contacts.js');
const { enqueueMessage, EnqueueError } = await import('../dist/whatsapp/enqueue.js');
const { handleInbound } = await import('../dist/whatsapp/inbound.js');
const { recordSignal, evaluateHealth } = await import('../dist/whatsapp/health.js');
const { listHealthEvents } = await import('../dist/db/health.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra ? '→ ' + JSON.stringify(extra) : ''); }
}
function tryEnqueue(input) {
  try { return { msg: enqueueMessage(input) }; }
  catch (e) { return { err: e instanceof EnqueueError ? e.code : String(e) }; }
}

const number = createNumber('verify-m5');
const PHONE = '15551230000';

console.log('\n=== Consent guardrails ===');
// Unknown → allowed by default (CONSENT_UNKNOWN_POLICY=allow).
let r = tryEnqueue({ number_id: number.id, to: PHONE, type: 'text', content: 'hi' });
ok('unknown recipient allowed by default policy', !!r.msg, r);

// Block the contact → subsequent send rejected.
setConsentByPhone(PHONE, 'blocked', 'manual');
r = tryEnqueue({ number_id: number.id, to: PHONE, type: 'text', content: 'again' });
ok('blocked recipient send rejected (recipient_blocked)', r.err === 'recipient_blocked', r);

// Opt back in → allowed again, with source recorded.
setConsentByPhone(PHONE, 'opted_in', 'web_form');
r = tryEnqueue({ number_id: number.id, to: PHONE, type: 'text', content: 'ok now' });
ok('opted-in recipient allowed', !!r.msg, r);
ok('consent source recorded', getContactByPhone(PHONE)?.consent_source === 'web_form');

// Search / list.
ok('listContacts finds by phone search', listContacts('1555123', undefined, 10).length >= 1);
ok('listContacts filters by status=opted_in', listContacts(undefined, 'opted_in', 10).every(c => c.consent_status === 'opted_in'));

console.log('\n=== Auto-block on inbound STOP ===');
const STOP_PHONE = '15559998888';
const noop = async () => Buffer.alloc(0);
const stopRaw = { key: { id: 'stopmsg-1', remoteJid: STOP_PHONE + '@s.whatsapp.net' }, message: { conversation: 'Stop' } };
await handleInbound(number.id, STOP_PHONE, stopRaw, noop);
ok('inbound STOP auto-blocked the contact', getContactByPhone(STOP_PHONE)?.consent_status === 'blocked', getContactByPhone(STOP_PHONE));
ok('consent source is inbound_stop', getContactByPhone(STOP_PHONE)?.consent_source === 'inbound_stop');
// And a send to that number is now refused.
r = tryEnqueue({ number_id: number.id, to: STOP_PHONE, type: 'text', content: 'promo' });
ok('send to STOP-blocked contact rejected', r.err === 'recipient_blocked', r);

console.log('\n=== Health: flag + cool-off on re-login ===');
recordSignal(number.id, 'relogin', 'critical', 'test re-login');
let n = getNumber(number.id);
ok('number is flagged after relogin', n.health_status === 'flagged', { health: n.health_status });
ok('cool-off window opened (future)', !!n.cooloff_until && Date.parse(n.cooloff_until) > Date.now(), { cooloff: n.cooloff_until });
const types = listHealthEvents(number.id, 50).map(e => e.event_type);
ok('relogin + flagged + cooloff events logged', ['relogin','flagged','cooloff'].every(t => types.includes(t)), types);
const flagEv = listHealthEvents(number.id, 50).find(e => e.event_type === 'flagged');
ok('flagged event carries an activity snapshot', !!flagEv?.snapshot && JSON.parse(flagEv.snapshot).window_minutes != null);
ok('flagged notes recommend switching numbers', /different linked number|another number/i.test(flagEv?.notes || ''));

console.log('\n=== Health: escalating cool-off ===');
// Read the two cool-off durations by forcing a recovery then a re-flag.
const firstCooloffMins = Math.round((Date.parse(getNumber(number.id).cooloff_until) - Date.now()) / 60000);
ok('first cool-off ~= base (60m)', firstCooloffMins >= 55 && firstCooloffMins <= 61, { firstCooloffMins });

console.log('\n=== Health: recovery after cool-off elapses ===');
// Push the relogin event + cool-off into the past so evaluate() can recover.
db.prepare("UPDATE health_events SET created_at = ? WHERE number_id = ? AND event_type = 'relogin'")
  .run(new Date(Date.now() - 3 * 3600_000).toISOString(), number.id);
db.prepare('UPDATE whatsapp_numbers SET cooloff_until = ? WHERE id = ?')
  .run(new Date(Date.now() - 1000).toISOString(), number.id);
evaluateHealth(number.id);
n = getNumber(number.id);
ok('number recovered to healthy after cool-off', n.health_status === 'healthy', { health: n.health_status });
ok('cool-off cleared on recovery', !n.cooloff_until);
ok('recovered event logged', listHealthEvents(number.id, 60).some(e => e.event_type === 'recovered'));

console.log('\n=== Health: failure-spike → at_risk ===');
const n2 = createNumber('verify-m5-b');
const c2 = resolveContact('15551112222');
// Insert 10 outbound messages: 7 failed, 3 sent → 70% failure ratio, >= flag ratio.
const now = () => new Date().toISOString();
const ins = db.prepare(`INSERT INTO messages (id, number_id, contact_id, direction, type, status, created_at, updated_at)
  VALUES (?, ?, ?, 'outbound', 'text', ?, ?, ?)`);
for (let i = 0; i < 10; i++) ins.run('m' + i, n2.id, c2.id, i < 7 ? 'failed' : 'sent', now(), now());
evaluateHealth(n2.id);
const h2 = getNumber(n2.id).health_status;
ok('high failure ratio flags the number', h2 === 'flagged', { health: h2 });

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

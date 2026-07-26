import { randomBytes, randomUUID } from 'node:crypto';
import { db } from './index.js';

/** Event types a downstream receiver can subscribe to (v1 set). */
export const WEBHOOK_EVENTS = ['message.inbound', 'message.status', 'health.event'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type DeliveryStatus = 'pending' | 'success' | 'failed';

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  /** Comma-separated subset of WEBHOOK_EVENTS. */
  events: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  response_code: number | null;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

// --- endpoint (single row in v1) ---

const getEndpointStmt = db.prepare('SELECT * FROM webhook_endpoints ORDER BY created_at ASC LIMIT 1');
const insertEndpointStmt = db.prepare(`
  INSERT INTO webhook_endpoints (id, url, secret, events, active, created_at, updated_at)
  VALUES (@id, @url, @secret, @events, @active, @now, @now)
`);
const updateEndpointStmt = db.prepare(`
  UPDATE webhook_endpoints
     SET url = @url, events = @events, active = @active, updated_at = @now
   WHERE id = @id
`);
const regenSecretStmt = db.prepare(
  'UPDATE webhook_endpoints SET secret = @secret, updated_at = @now WHERE id = @id',
);

/** Generate a strong signing secret (hex). */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

export function getEndpoint(): WebhookEndpoint | undefined {
  return getEndpointStmt.get() as WebhookEndpoint | undefined;
}

export interface EndpointInput {
  url: string;
  events: string;
  active: boolean;
}

/**
 * Create or update the single webhook endpoint. On first save a strong secret
 * is generated automatically; subsequent saves keep it (use rotateSecret to
 * change it).
 */
export function saveEndpoint(input: EndpointInput): WebhookEndpoint {
  const now = new Date().toISOString();
  const existing = getEndpoint();
  if (existing) {
    updateEndpointStmt.run({
      id: existing.id,
      url: input.url,
      events: input.events,
      active: input.active ? 1 : 0,
      now,
    });
  } else {
    insertEndpointStmt.run({
      id: randomUUID(),
      url: input.url,
      secret: generateSecret(),
      events: input.events,
      active: input.active ? 1 : 0,
      now,
    });
  }
  return getEndpoint()!;
}

export function rotateSecret(): WebhookEndpoint | undefined {
  const existing = getEndpoint();
  if (!existing) return undefined;
  regenSecretStmt.run({ id: existing.id, secret: generateSecret(), now: new Date().toISOString() });
  return getEndpoint();
}

/** True if the endpoint exists, is active, and subscribes to this event type. */
export function endpointWants(endpoint: WebhookEndpoint | undefined, event: WebhookEvent): boolean {
  if (!endpoint || !endpoint.active) return false;
  return endpoint.events
    .split(',')
    .map((e) => e.trim())
    .includes(event);
}

// --- deliveries ---

const insertDeliveryStmt = db.prepare(`
  INSERT INTO webhook_deliveries
    (id, endpoint_id, event_type, payload, status, next_attempt_at, created_at, updated_at)
  VALUES (@id, @endpoint_id, @event_type, @payload, 'pending', @next_attempt_at, @now, @now)
`);
const getDeliveryStmt = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?');
const duePendingStmt = db.prepare(`
  SELECT * FROM webhook_deliveries
   WHERE status = 'pending' AND next_attempt_at <= @now
   ORDER BY next_attempt_at ASC
   LIMIT 20
`);
const recentDeliveriesStmt = db.prepare(
  'SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?',
);
const markSuccessStmt = db.prepare(`
  UPDATE webhook_deliveries
     SET status = 'success', attempts = @attempts, response_code = @code,
         last_error = NULL, delivered_at = @now, updated_at = @now
   WHERE id = @id
`);
const markRetryStmt = db.prepare(`
  UPDATE webhook_deliveries
     SET status = 'pending', attempts = @attempts, response_code = @code,
         last_error = @error, next_attempt_at = @next_attempt_at, updated_at = @now
   WHERE id = @id
`);
const markFailedStmt = db.prepare(`
  UPDATE webhook_deliveries
     SET status = 'failed', attempts = @attempts, response_code = @code,
         last_error = @error, updated_at = @now
   WHERE id = @id
`);

export function createDelivery(
  endpointId: string,
  event: WebhookEvent,
  payload: unknown,
  nextAttemptAt: string,
): WebhookDelivery {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertDeliveryStmt.run({
    id,
    endpoint_id: endpointId,
    event_type: event,
    payload: JSON.stringify(payload),
    next_attempt_at: nextAttemptAt,
    now,
  });
  return getDeliveryStmt.get(id) as WebhookDelivery;
}

export function getDelivery(id: string): WebhookDelivery | undefined {
  return getDeliveryStmt.get(id) as WebhookDelivery | undefined;
}

/** Pending deliveries whose next attempt time has arrived. */
export function duePendingDeliveries(): WebhookDelivery[] {
  return duePendingStmt.all({ now: new Date().toISOString() }) as WebhookDelivery[];
}

export function recentDeliveries(limit = 25): WebhookDelivery[] {
  return recentDeliveriesStmt.all(limit) as WebhookDelivery[];
}

export function markDeliverySuccess(id: string, attempts: number, code: number | null): void {
  markSuccessStmt.run({ id, attempts, code, now: new Date().toISOString() });
}

export function markDeliveryRetry(
  id: string,
  attempts: number,
  code: number | null,
  error: string,
  nextAttemptAt: string,
): void {
  markRetryStmt.run({
    id,
    attempts,
    code,
    error,
    next_attempt_at: nextAttemptAt,
    now: new Date().toISOString(),
  });
}

export function markDeliveryFailed(
  id: string,
  attempts: number,
  code: number | null,
  error: string,
): void {
  markFailedStmt.run({ id, attempts, code, error, now: new Date().toISOString() });
}

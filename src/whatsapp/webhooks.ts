/**
 * Outbound webhooks. Delivery is durable: every event is written to the
 * webhook_deliveries table first, then a single non-overlapping worker attempts
 * (and retries, with exponential backoff) HTTP POSTs to the configured endpoint.
 * Payloads are signed with the endpoint secret (HMAC-SHA256) so the receiver can
 * verify authenticity.
 */
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { getContact } from '../db/contacts.js';
import { getMessage, type Message, type MessageStatus } from '../db/messages.js';
import type { HealthEvent } from '../db/health.js';
import type { HealthStatus } from '../db/numbers.js';
import { isoInTz } from '../time.js';
import {
  createDelivery,
  duePendingDeliveries,
  endpointWants,
  getDelivery,
  getEndpoint,
  markDeliveryFailed,
  markDeliveryRetry,
  markDeliverySuccess,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from '../db/webhooks.js';

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const webhookCfg = {
  /** How often the retry worker looks for due deliveries. */
  tickMs: num(process.env.WEBHOOK_TICK_MS, 1000),
  /** Per-request timeout. */
  timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10000),
  /** Total delivery attempts before a delivery is marked permanently failed. */
  maxAttempts: num(process.env.WEBHOOK_MAX_ATTEMPTS, 6),
  /** Base backoff; each retry doubles it (capped at maxBackoffMs). */
  retryBackoffMs: num(process.env.WEBHOOK_RETRY_BACKOFF_MS, 10000),
  maxBackoffMs: num(process.env.WEBHOOK_MAX_BACKOFF_MS, 3600000),
} as const;

// --- signing ---

/** HMAC-SHA256 of the raw JSON body, hex-encoded (matches header format). */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// --- payload builders ---

function mediaUrlFor(message: Message): string | null {
  if (!message.media_path) return null;
  return `${config.publicBaseUrl}/api/v1/messages/${message.id}/media`;
}

function inboundPayload(message: Message, isStop: boolean) {
  const contact = getContact(message.contact_id);
  return {
    message_id: message.id,
    number_id: message.number_id,
    direction: 'inbound' as const,
    from: contact?.phone_number ?? null,
    type: message.type,
    content: message.content,
    caption: message.caption,
    media_url: mediaUrlFor(message),
    is_stop: isStop,
    provider_message_id: message.provider_message_id,
    received_at: message.created_at,
    received_at_local: isoInTz(message.created_at),
    timezone: config.displayTz,
  };
}

function statusPayload(message: Message, status: MessageStatus) {
  const contact = getContact(message.contact_id);
  return {
    message_id: message.id,
    number_id: message.number_id,
    direction: message.direction,
    to: contact?.phone_number ?? null,
    status,
    provider_message_id: message.provider_message_id,
    failure_reason: message.failure_reason,
    updated_at: message.updated_at,
    updated_at_local: isoInTz(message.updated_at),
    timezone: config.displayTz,
  };
}

function healthPayload(
  numberId: string,
  event: HealthEvent,
  status: HealthStatus,
  extra?: Record<string, unknown>,
) {
  return {
    number_id: numberId,
    health_status: status,
    event_type: event.event_type,
    severity: event.severity,
    notes: event.notes,
    snapshot: event.snapshot ? JSON.parse(event.snapshot) : null,
    occurred_at: event.created_at,
    occurred_at_local: isoInTz(event.created_at),
    timezone: config.displayTz,
    ...extra,
  };
}

// --- emission ---

/** Queue an event for delivery if the endpoint is active and subscribed. */
function emit(event: WebhookEvent, data: unknown): void {
  const endpoint = getEndpoint();
  if (!endpointWants(endpoint, event)) return;
  const envelope = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  createDelivery(endpoint!.id, event, envelope, new Date().toISOString());
  // Nudge the worker so subscribers get events promptly (guarded, so no double-send).
  void pump();
}

/** Fire a `message.inbound` webhook for a freshly received message. */
export function emitInbound(message: Message, isStop: boolean): void {
  emit('message.inbound', inboundPayload(message, isStop));
}

/** Fire a `message.status` webhook for an outbound status transition. */
export function emitMessageStatus(messageId: string, status: MessageStatus): void {
  const message = getMessage(messageId);
  if (!message) return;
  emit('message.status', statusPayload(message, status));
}

/** Fire a `health.event` webhook for a number's health signal / transition. */
export function emitHealth(
  numberId: string,
  event: HealthEvent,
  status: HealthStatus,
  extra?: Record<string, unknown>,
): void {
  emit('health.event', healthPayload(numberId, event, status, extra));
}

// --- delivery worker ---

let timer: NodeJS.Timeout | null = null;
let working = false;

export function startWebhookWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void pump();
  }, webhookCfg.tickMs);
}

export function stopWebhookWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Attempt all due deliveries, one worker pass, never overlapping. */
async function pump(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (const delivery of duePendingDeliveries()) {
      await attemptDelivery(delivery);
    }
  } catch {
    /* a bad pass must never kill the interval */
  } finally {
    working = false;
  }
}

function backoffMs(attempt: number): number {
  const ms = webhookCfg.retryBackoffMs * 2 ** (attempt - 1);
  return Math.min(ms, webhookCfg.maxBackoffMs);
}

async function attemptDelivery(delivery: WebhookDelivery): Promise<void> {
  const endpoint = getEndpoint();
  // Endpoint changed/removed since the event was queued — stop trying.
  if (!endpoint || endpoint.id !== delivery.endpoint_id) {
    markDeliveryFailed(delivery.id, delivery.attempts, null, 'endpoint_removed');
    return;
  }

  const attempts = delivery.attempts + 1;
  const body = delivery.payload; // already the JSON string we signed originally
  const signature = signPayload(endpoint.secret, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), webhookCfg.timeoutMs);

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `${config.appName}-Webhook`,
        'x-waguard-event': delivery.event_type,
        'x-waguard-delivery': delivery.id,
        'x-waguard-timestamp': new Date().toISOString(),
        'x-waguard-signature': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      markDeliverySuccess(delivery.id, attempts, res.status);
    } else {
      failOrRetry(delivery.id, attempts, res.status, `http_${res.status}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failOrRetry(delivery.id, attempts, null, reason);
  } finally {
    clearTimeout(timeout);
  }
}

function failOrRetry(id: string, attempts: number, code: number | null, error: string): void {
  if (attempts >= webhookCfg.maxAttempts) {
    markDeliveryFailed(id, attempts, code, error);
  } else {
    const nextAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
    markDeliveryRetry(id, attempts, code, error, nextAt);
  }
}

/**
 * Send a one-off test event to verify URL + secret from the dashboard. Bypasses
 * event-subscription filtering (but still requires a saved endpoint) and is
 * recorded in the delivery log like any other event.
 */
export function sendTestEvent(): boolean {
  const endpoint = getEndpoint();
  if (!endpoint) return false;
  const envelope = {
    event: 'message.status' as const,
    timestamp: new Date().toISOString(),
    data: { test: true, message: 'WaGuard webhook test event' },
  };
  const delivery = createDelivery(endpoint.id, 'message.status', envelope, new Date().toISOString());
  void attemptDelivery(getDelivery(delivery.id)!);
  return true;
}

import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type MessageType = 'text' | 'image' | 'document' | 'audio' | 'video';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type JobState = 'waiting' | 'processing' | 'done' | 'failed';

export interface Message {
  id: string;
  number_id: string;
  contact_id: string | null;
  direction: 'outbound' | 'inbound';
  type: MessageType;
  content: string | null;
  caption: string | null;
  media_url: string | null;
  media_path: string | null;
  status: MessageStatus;
  provider_message_id: string | null;
  failure_reason: string | null;
  created_at: string;
  sent_at: string | null;
  updated_at: string;
  template_id: string | null;
  group_id: string | null;
  broadcast_id: string | null;
}

export interface QueuedJob {
  id: string;
  message_id: string;
  number_id: string;
  scheduled_send_at: string;
  attempts: number;
  state: JobState;
  applied_delay_ms: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// --- messages ---

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (id, number_id, contact_id, direction, type, content, caption,
                        media_url, media_path, status, created_at, updated_at, template_id,
                        group_id, broadcast_id)
  VALUES (@id, @number_id, @contact_id, 'outbound', @type, @content, @caption,
          @media_url, @media_path, 'queued', @now, @now, @template_id,
          @group_id, @broadcast_id)
`);
const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
const getByProviderStmt = db.prepare('SELECT * FROM messages WHERE provider_message_id = ?');
const setStatusStmt = db.prepare(
  'UPDATE messages SET status = @status, updated_at = @now WHERE id = @id',
);
const markSentStmt = db.prepare(`
  UPDATE messages
     SET status = 'sent', provider_message_id = @pid, sent_at = @now, updated_at = @now
   WHERE id = @id
`);
const markFailedStmt = db.prepare(`
  UPDATE messages SET status = 'failed', failure_reason = @reason, updated_at = @now WHERE id = @id
`);

export interface NewMessage {
  number_id: string;
  /** Null for group sends (no individual contact). */
  contact_id?: string | null;
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
  template_id?: string | null;
  group_id?: string | null;
  broadcast_id?: string | null;
}

export function createMessage(m: NewMessage): Message {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertMessageStmt.run({
    id,
    number_id: m.number_id,
    contact_id: m.contact_id ?? null,
    type: m.type,
    content: m.content ?? null,
    caption: m.caption ?? null,
    media_url: m.media_url ?? null,
    media_path: m.media_path ?? null,
    template_id: m.template_id ?? null,
    group_id: m.group_id ?? null,
    broadcast_id: m.broadcast_id ?? null,
    now,
  });
  return getMessage(id)!;
}

const insertInboundStmt = db.prepare(`
  INSERT INTO messages (id, number_id, contact_id, direction, type, content, caption,
                        media_path, status, provider_message_id, created_at, updated_at, group_id)
  VALUES (@id, @number_id, @contact_id, 'inbound', @type, @content, @caption,
          @media_path, 'delivered', @provider_message_id, @now, @now, @group_id)
`);

export interface NewInboundMessage {
  number_id: string;
  contact_id: string;
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_path?: string | null;
  provider_message_id?: string | null;
  /** Set when the message arrived in a synced WhatsApp group. */
  group_id?: string | null;
}

/** Store a received message. Inbound messages are 'delivered' on arrival. */
export function createInboundMessage(m: NewInboundMessage): Message {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertInboundStmt.run({
    id,
    number_id: m.number_id,
    contact_id: m.contact_id,
    type: m.type,
    content: m.content ?? null,
    caption: m.caption ?? null,
    media_path: m.media_path ?? null,
    provider_message_id: m.provider_message_id ?? null,
    group_id: m.group_id ?? null,
    now,
  });
  return getMessage(id)!;
}

export function getMessage(id: string): Message | undefined {
  return getMessageStmt.get(id) as Message | undefined;
}

export function getMessageByProviderId(pid: string): Message | undefined {
  return getByProviderStmt.get(pid) as Message | undefined;
}

/** Recent messages, newest first; optionally filter by number and/or direction. */
export function listMessages(
  limit = 50,
  numberId?: string,
  direction?: 'inbound' | 'outbound',
): Message[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (numberId) {
    where.push('number_id = ?');
    params.push(numberId);
  }
  if (direction) {
    where.push('direction = ?');
    params.push(direction);
  }
  const sql =
    `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as Message[];
}

/** Total message count, optionally filtered by direction (for the Overview page). */
export function countMessages(direction?: 'inbound' | 'outbound'): number {
  const sql = direction
    ? 'SELECT COUNT(*) AS n FROM messages WHERE direction = ?'
    : 'SELECT COUNT(*) AS n FROM messages';
  const row = (direction ? db.prepare(sql).get(direction) : db.prepare(sql).get()) as { n: number };
  return row.n;
}

export function markMessageSent(id: string, providerId: string | null): void {
  markSentStmt.run({ id, pid: providerId, now: new Date().toISOString() });
}

/**
 * Advance a message's delivery status, but never move backwards
 * (read > delivered > sent). Used by the provider status listener.
 */
const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 1,
};
export function advanceMessageStatus(id: string, status: MessageStatus): boolean {
  const row = getMessage(id);
  if (!row) return false;
  if (STATUS_RANK[status] <= STATUS_RANK[row.status]) return false;
  setStatusStmt.run({ id, status, now: new Date().toISOString() });
  return true;
}

export function markMessageFailed(id: string, reason: string): void {
  markFailedStmt.run({ id, reason, now: new Date().toISOString() });
}

// --- queued_jobs ---

const insertJobStmt = db.prepare(`
  INSERT INTO queued_jobs (id, message_id, number_id, scheduled_send_at, state, created_at, updated_at)
  VALUES (@id, @message_id, @number_id, @scheduled_send_at, 'waiting', @now, @now)
`);
const getJobStmt = db.prepare('SELECT * FROM queued_jobs WHERE id = ?');
const getJobByMessageStmt = db.prepare('SELECT * FROM queued_jobs WHERE message_id = ?');
const dueWaitingStmt = db.prepare(`
  SELECT * FROM queued_jobs
   WHERE state = 'waiting' AND scheduled_send_at <= @now
   ORDER BY scheduled_send_at ASC
`);
const jobsForNumberStmt = db.prepare(
  "SELECT * FROM queued_jobs WHERE number_id = ? AND state IN ('waiting','processing','failed') ORDER BY scheduled_send_at ASC",
);
const countByStateStmt = db.prepare(
  'SELECT state, COUNT(*) AS n FROM queued_jobs WHERE number_id = ? GROUP BY state',
);
const setJobStateStmt = db.prepare(
  'UPDATE queued_jobs SET state = @state, updated_at = @now WHERE id = @id',
);
const rescheduleJobStmt = db.prepare(`
  UPDATE queued_jobs
     SET state = 'waiting', attempts = attempts + 1, scheduled_send_at = @at,
         last_error = @err, updated_at = @now
   WHERE id = @id
`);
const deferJobStmt = db.prepare(`
  UPDATE queued_jobs
     SET state = 'waiting', scheduled_send_at = @at, last_error = @err, updated_at = @now
   WHERE id = @id
`);
const failJobStmt = db.prepare(`
  UPDATE queued_jobs
     SET state = 'failed', attempts = attempts + 1, last_error = @err, updated_at = @now
   WHERE id = @id
`);
const setAppliedDelayStmt = db.prepare(
  'UPDATE queued_jobs SET applied_delay_ms = @ms, updated_at = @now WHERE id = @id',
);
const resetProcessingStmt = db.prepare(
  "UPDATE queued_jobs SET state = 'waiting', updated_at = ? WHERE state = 'processing'",
);

export function createJob(messageId: string, numberId: string, scheduledSendAt: string): QueuedJob {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertJobStmt.run({ id, message_id: messageId, number_id: numberId, scheduled_send_at: scheduledSendAt, now });
  return getJobStmt.get(id) as QueuedJob;
}

export function getJob(id: string): QueuedJob | undefined {
  return getJobStmt.get(id) as QueuedJob | undefined;
}

export function getJobByMessage(messageId: string): QueuedJob | undefined {
  return getJobByMessageStmt.get(messageId) as QueuedJob | undefined;
}

/** All 'waiting' jobs whose scheduled time has arrived, soonest first. */
export function dueWaitingJobs(): QueuedJob[] {
  return dueWaitingStmt.all({ now: new Date().toISOString() }) as QueuedJob[];
}

export function jobsForNumber(numberId: string): QueuedJob[] {
  return jobsForNumberStmt.all(numberId) as QueuedJob[];
}

export function jobCountsForNumber(numberId: string): Record<JobState, number> {
  const out: Record<JobState, number> = { waiting: 0, processing: 0, done: 0, failed: 0 };
  for (const r of countByStateStmt.all(numberId) as Array<{ state: JobState; n: number }>) {
    out[r.state] = r.n;
  }
  return out;
}

export function setJobState(id: string, state: JobState): void {
  setJobStateStmt.run({ id, state, now: new Date().toISOString() });
}

export function setJobAppliedDelay(id: string, ms: number): void {
  setAppliedDelayStmt.run({ id, ms, now: new Date().toISOString() });
}

export function rescheduleJob(id: string, at: string, err: string): void {
  rescheduleJobStmt.run({ id, at, err, now: new Date().toISOString() });
}

/** Push a job's next run out without counting a retry attempt (holds/backpressure). */
export function deferJob(id: string, at: string, reason: string): void {
  deferJobStmt.run({ id, at, err: reason, now: new Date().toISOString() });
}

export function failJob(id: string, err: string): void {
  failJobStmt.run({ id, err, now: new Date().toISOString() });
}

/** Crash recovery on boot: any job left 'processing' is returned to 'waiting'. */
export function resetStuckJobs(): void {
  resetProcessingStmt.run(new Date().toISOString());
}

const retryFailedStmt = db.prepare(`
  UPDATE queued_jobs
     SET state = 'waiting', scheduled_send_at = @now, last_error = NULL, updated_at = @now
   WHERE number_id = @number_id AND state = 'failed'
`);
const requeueFailedMessagesStmt = db.prepare(`
  UPDATE messages SET status = 'queued', failure_reason = NULL, updated_at = @now
   WHERE number_id = @number_id AND status = 'failed'
`);

/** Requeue every failed job/message for a number (manual retry from the dashboard). */
export function retryFailedForNumber(numberId: string): void {
  const now = new Date().toISOString();
  retryFailedStmt.run({ number_id: numberId, now });
  requeueFailedMessagesStmt.run({ number_id: numberId, now });
}

import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type MessageType = 'text' | 'image' | 'document' | 'audio' | 'video';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type JobState = 'waiting' | 'processing' | 'done' | 'failed';

export interface Message {
  id: string;
  number_id: string;
  contact_id: string;
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
                        media_url, media_path, status, created_at, updated_at)
  VALUES (@id, @number_id, @contact_id, 'outbound', @type, @content, @caption,
          @media_url, @media_path, 'queued', @now, @now)
`);
const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
const getByProviderStmt = db.prepare('SELECT * FROM messages WHERE provider_message_id = ?');
const listMessagesStmt = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?');
const listMessagesByNumberStmt = db.prepare(
  'SELECT * FROM messages WHERE number_id = ? ORDER BY created_at DESC LIMIT ?',
);
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
  contact_id: string;
  type: MessageType;
  content?: string | null;
  caption?: string | null;
  media_url?: string | null;
  media_path?: string | null;
}

export function createMessage(m: NewMessage): Message {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertMessageStmt.run({
    id,
    number_id: m.number_id,
    contact_id: m.contact_id,
    type: m.type,
    content: m.content ?? null,
    caption: m.caption ?? null,
    media_url: m.media_url ?? null,
    media_path: m.media_path ?? null,
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

export function listMessages(limit = 50, numberId?: string): Message[] {
  return (
    numberId ? listMessagesByNumberStmt.all(numberId, limit) : listMessagesStmt.all(limit)
  ) as Message[];
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
export function advanceMessageStatus(id: string, status: MessageStatus): void {
  const row = getMessage(id);
  if (!row) return;
  if (STATUS_RANK[status] <= STATUS_RANK[row.status]) return;
  setStatusStmt.run({ id, status, now: new Date().toISOString() });
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

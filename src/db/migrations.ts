import type { Database } from 'better-sqlite3';

/**
 * Idempotent schema setup. Each milestone adds its own tables here. Milestone 1
 * introduces the settings store (admin credentials) and API tokens.
 */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      scopes       TEXT NOT NULL DEFAULT 'send,read',
      active       INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_numbers (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      phone_number TEXT,
      status       TEXT NOT NULL DEFAULT 'connecting',
      created_at   TEXT NOT NULL,
      linked_at    TEXT
    );

    -- Milestone 3: contacts (recipients), messages, and the anti-ban send queue.

    CREATE TABLE IF NOT EXISTS contacts (
      id                 TEXT PRIMARY KEY,
      phone_number       TEXT NOT NULL UNIQUE,
      display_name       TEXT,
      consent_status     TEXT NOT NULL DEFAULT 'unknown',
      consent_source     TEXT,
      first_contacted_at TEXT,
      last_contacted_at  TEXT,
      created_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  TEXT PRIMARY KEY,
      number_id           TEXT NOT NULL,
      contact_id          TEXT NOT NULL,
      direction           TEXT NOT NULL DEFAULT 'outbound',
      type                TEXT NOT NULL DEFAULT 'text',
      content             TEXT,
      caption             TEXT,
      media_url           TEXT,
      media_path          TEXT,
      status              TEXT NOT NULL DEFAULT 'queued',
      provider_message_id TEXT,
      failure_reason      TEXT,
      created_at          TEXT NOT NULL,
      sent_at             TEXT,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_number ON messages(number_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_message_id);

    CREATE TABLE IF NOT EXISTS queued_jobs (
      id                TEXT PRIMARY KEY,
      message_id        TEXT NOT NULL,
      number_id         TEXT NOT NULL,
      scheduled_send_at TEXT NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0,
      state             TEXT NOT NULL DEFAULT 'waiting',
      applied_delay_ms  INTEGER,
      last_error        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_pick ON queued_jobs(state, number_id, scheduled_send_at);

    -- Milestone 4: the (single, in v1) outbound webhook endpoint and a durable
    -- delivery log so events survive a temporarily-down receiver and can retry.

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id         TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      secret     TEXT NOT NULL,
      events     TEXT NOT NULL DEFAULT 'message.inbound,message.status',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              TEXT PRIMARY KEY,
      endpoint_id     TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      response_code   INTEGER,
      last_error      TEXT,
      next_attempt_at TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      delivered_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_pending
      ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_recent
      ON webhook_deliveries(created_at);
  `);

  // Idempotent ALTERs add the per-number anti-ban / warm-up columns introduced
  // in Milestone 3 without disturbing the Milestone 2 table definition above.
  addColumnIfMissing(db, 'whatsapp_numbers', 'warmup_started_at', 'TEXT');
  addColumnIfMissing(db, 'whatsapp_numbers', 'daily_sent_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'whatsapp_numbers', 'daily_count_date', 'TEXT');
  addColumnIfMissing(db, 'whatsapp_numbers', 'queue_paused', 'INTEGER NOT NULL DEFAULT 0');
}

/** Add a column only if it isn't already present — keeps migrations rerun-safe. */
function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

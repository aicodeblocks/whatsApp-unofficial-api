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
      contact_id          TEXT,
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

    -- Milestone 5: the per-number health/feedback timeline. Each notable event
    -- (disconnect, re-login prompt, delivery drop, failure spike, at-risk,
    -- cool-off, flagged, recovered) is stored with a snapshot of the surrounding
    -- activity so you can learn what led up to a flag.

    CREATE TABLE IF NOT EXISTS health_events (
      id         TEXT PRIMARY KEY,
      number_id  TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity   TEXT NOT NULL DEFAULT 'info',
      snapshot   TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_health_number ON health_events(number_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_health_type ON health_events(number_id, event_type, created_at);

    -- v2 Milestone 3: contact lists/segments, CSV import records, the template
    -- library, and interactive buttons (attachable to a template or a single
    -- sent message via owner_type/owner_id — one table instead of two).

    CREATE TABLE IF NOT EXISTS contact_lists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_list_members (
      list_id    TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (list_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_list_members_contact ON contact_list_members(contact_id);

    CREATE TABLE IF NOT EXISTS contact_imports (
      id              TEXT PRIMARY KEY,
      file_name       TEXT NOT NULL,
      list_id         TEXT NOT NULL,
      total_rows      INTEGER NOT NULL DEFAULT 0,
      imported_count  INTEGER NOT NULL DEFAULT 0,
      skipped_count   INTEGER NOT NULL DEFAULT 0,
      invalid_count   INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'completed',
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT,
      body       TEXT NOT NULL DEFAULT '',
      media_path TEXT,
      media_url  TEXT,
      media_type TEXT NOT NULL DEFAULT 'document',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS buttons (
      id         TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      type       TEXT NOT NULL,
      label      TEXT NOT NULL,
      payload    TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_buttons_owner ON buttons(owner_type, owner_id, sort_order);

    -- v2 Milestone 4: broadcast campaigns (bulk sends to a contact list, under
    -- the same anti-ban queue) and synced WhatsApp groups (send-only).

    CREATE TABLE IF NOT EXISTS broadcast_campaigns (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      number_id         TEXT NOT NULL,
      list_id           TEXT NOT NULL,
      template_id       TEXT,
      content           TEXT,
      caption           TEXT,
      media_url         TEXT,
      media_path        TEXT,
      type              TEXT NOT NULL DEFAULT 'text',
      schedule_at       TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      total_recipients  INTEGER NOT NULL DEFAULT 0,
      skipped_count     INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id                 TEXT PRIMARY KEY,
      number_id          TEXT NOT NULL,
      provider_group_id  TEXT NOT NULL,
      subject            TEXT,
      participant_count  INTEGER NOT NULL DEFAULT 0,
      last_synced_at     TEXT,
      created_at         TEXT NOT NULL,
      UNIQUE(number_id, provider_group_id)
    );
  `);

  // v2 M4: existing installs created `messages.contact_id` as NOT NULL (M3's
  // original schema); group messages have no individual contact, so it must
  // become nullable. ADD COLUMN can't relax NOT NULL, so rebuild the table.
  // No-op on fresh installs, where the CREATE TABLE above already made it
  // nullable.
  ensureMessagesContactIdNullable(db);

  // v2 M3: link a sent message back to the template it came from (if any).
  addColumnIfMissing(db, 'messages', 'template_id', 'TEXT');

  // v2 M4: link a message to the WhatsApp group it was sent to / received
  // from, and to the broadcast campaign that generated it (both nullable —
  // most messages are neither).
  addColumnIfMissing(db, 'messages', 'group_id', 'TEXT');
  addColumnIfMissing(db, 'messages', 'broadcast_id', 'TEXT');

  // Idempotent ALTERs add the per-number anti-ban / warm-up columns introduced
  // in Milestone 3 without disturbing the Milestone 2 table definition above.
  addColumnIfMissing(db, 'whatsapp_numbers', 'warmup_started_at', 'TEXT');
  addColumnIfMissing(db, 'whatsapp_numbers', 'daily_sent_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'whatsapp_numbers', 'daily_count_date', 'TEXT');
  addColumnIfMissing(db, 'whatsapp_numbers', 'queue_paused', 'INTEGER NOT NULL DEFAULT 0');

  // Milestone 5 — per-number health state and anti-ban cool-off.
  //   health_status: healthy | at_risk | flagged  (the live health signal).
  //   cooloff_until: while in the future, the number is held out of use (a
  //                  computed rest period after a flag) — sending is paused and
  //                  the dashboard recommends switching to another number.
  addColumnIfMissing(db, 'whatsapp_numbers', 'health_status', "TEXT NOT NULL DEFAULT 'healthy'");
  addColumnIfMissing(db, 'whatsapp_numbers', 'cooloff_until', 'TEXT');
}

/** Add a column only if it isn't already present — keeps migrations rerun-safe. */
function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * One-time rebuild for installs created before v2 M4, where `contact_id` was
 * declared NOT NULL. Group messages have no individual contact, so the column
 * must become nullable — SQLite can't relax a NOT NULL via ALTER, so the table
 * is recreated, data copied across, and the old one dropped. Guarded by a
 * PRAGMA check so it runs at most once and is a no-op on fresh installs.
 */
function ensureMessagesContactIdNullable(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string; notnull: number }>;
  const contactCol = cols.find((c) => c.name === 'contact_id');
  if (!contactCol || contactCol.notnull === 0) return;

  // `template_id` (v2 M3) may already exist on the table being rebuilt — carry
  // it across explicitly so upgrading installs don't lose that data.
  const hasTemplateId = cols.some((c) => c.name === 'template_id');

  db.exec(`
    CREATE TABLE messages_new (
      id                  TEXT PRIMARY KEY,
      number_id           TEXT NOT NULL,
      contact_id          TEXT,
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
      updated_at          TEXT NOT NULL,
      template_id         TEXT
    );
    INSERT INTO messages_new (id, number_id, contact_id, direction, type, content, caption,
      media_url, media_path, status, provider_message_id, failure_reason, created_at, sent_at, updated_at${hasTemplateId ? ', template_id' : ''})
    SELECT id, number_id, contact_id, direction, type, content, caption,
      media_url, media_path, status, provider_message_id, failure_reason, created_at, sent_at, updated_at${hasTemplateId ? ', template_id' : ''}
    FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
    CREATE INDEX IF NOT EXISTS idx_messages_number ON messages(number_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_message_id);
  `);
}

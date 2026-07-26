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
  `);
}

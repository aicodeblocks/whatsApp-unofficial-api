import Database from 'better-sqlite3';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

/**
 * Single shared SQLite connection. better-sqlite3 is synchronous, which keeps
 * the data layer simple and fast for a lightweight single-tenant service.
 */
export const db = new Database(config.dbPath);

// Pragmas: WAL for better concurrency, foreign keys on for referential safety.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

runMigrations(db);

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Central runtime configuration, read from environment variables with safe
 * defaults so the service can boot with zero required configuration.
 */

const DATA_DIR = resolve(process.env.DATA_DIR ?? './data');

// Ensure the data directory (mounted as a Docker volume) exists on boot.
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * The session secret signs the admin login cookie. If the operator does not
 * supply one, we generate a persistent secret and store it alongside the data
 * so existing logins survive restarts without any required configuration.
 */
function resolveSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  const secretFile = resolve(DATA_DIR, '.session-secret');
  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }
  const generated = randomBytes(48).toString('hex');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  /** Directory for the SQLite database, sessions, and (later) media. */
  dataDir: DATA_DIR,
  /** SQLite database file path. */
  dbPath: resolve(DATA_DIR, 'waguard.db'),
  /** HTTP port the service listens on. */
  port: Number(process.env.PORT ?? 3000),
  /** Bind host — 0.0.0.0 so it is reachable from outside the container. */
  host: process.env.HOST ?? '0.0.0.0',
  /** Signs the admin session cookie. */
  sessionSecret: resolveSessionSecret(),
  /** Set true behind HTTPS so the session cookie is marked Secure. */
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  /** Marketing-friendly name surfaced in the dashboard and docs. */
  appName: 'WaGuard',
} as const;

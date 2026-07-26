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
  /**
   * Decorative image shown on the login page. Defaults to a random-photo
   * service (a fresh image each page load). Set LOGIN_IMAGE_URL to your own,
   * or to an empty string to hide it.
   */
  loginImageUrl: process.env.LOGIN_IMAGE_URL ?? 'https://picsum.photos/400/300.jpg',
  /**
   * Public base URL of this service, used to build absolute media-download URLs
   * inside webhook payloads (e.g. https://wa.example.com). Falls back to
   * http://<host>:<port>, which is only reachable if the receiver shares the
   * network — set this in production so downstream systems can fetch media.
   */
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`
  ).replace(/\/$/, ''),
  /**
   * Display timezone (IANA, e.g. "America/New_York") for the human-readable
   * local timestamps added to API responses, webhook payloads, and the
   * dashboard. Stored timestamps stay UTC ISO-8601; this only affects the extra
   * *_local fields. Defaults to QUIET_TZ, then the server's local timezone.
   * Validated at boot — an invalid zone falls back to UTC (with a warning)
   * rather than throwing on every timestamp format.
   */
  displayTz: resolveDisplayTz(),
} as const;

/** True if `tz` is a timezone Intl accepts (an invalid one throws). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Pick the display timezone from env, falling back safely to UTC if invalid. */
function resolveDisplayTz(): string {
  const candidate =
    process.env.APP_TZ ||
    process.env.QUIET_TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';
  if (isValidTimeZone(candidate)) return candidate;
  // eslint-disable-next-line no-console
  console.warn(`[config] Invalid APP_TZ "${candidate}" — falling back to UTC for display timestamps.`);
  return 'UTC';
}


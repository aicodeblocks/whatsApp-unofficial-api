import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './index.js';

const ADMIN_HASH_KEY = 'admin_password_hash';

const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setStmt = db.prepare(`
  INSERT INTO app_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key: string): string | undefined {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

function setSetting(key: string, value: string): void {
  setStmt.run(key, value);
}

/** True until the operator has completed the first-run admin setup. */
export function isFirstRun(): boolean {
  return getSetting(ADMIN_HASH_KEY) === undefined;
}

/** Hash and store the admin password. Format: scrypt as `salt:derivedKey` (hex). */
export function setAdminPassword(password: string): void {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  setSetting(ADMIN_HASH_KEY, `${salt.toString('hex')}:${derived.toString('hex')}`);
}

/** Constant-time verification of a candidate admin password. */
export function verifyAdminPassword(password: string): boolean {
  const stored = getSetting(ADMIN_HASH_KEY);
  if (!stored) return false;
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

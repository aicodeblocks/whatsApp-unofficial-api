import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './index.js';

export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string;
  active: number;
  last_used_at: string | null;
  created_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO api_tokens (id, name, token_hash, token_prefix, scopes, active, created_at)
  VALUES (@id, @name, @token_hash, @token_prefix, @scopes, 1, @created_at)
`);
const listStmt = db.prepare('SELECT id, name, token_prefix, scopes, active, last_used_at, created_at FROM api_tokens ORDER BY created_at DESC');
const revokeStmt = db.prepare('UPDATE api_tokens SET active = 0 WHERE id = ?');
const findByHashStmt = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND active = 1');
const touchStmt = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');

/** SHA-256 of the raw token; only the hash is ever stored. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Create a token. Returns the one-time plaintext value (shown once to the
 * operator) plus the stored record. The plaintext is never persisted.
 */
export function createToken(name: string): { token: string; record: ApiToken } {
  const raw = `wg_${randomBytes(24).toString('hex')}`;
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const record = {
    id,
    name,
    token_hash: hashToken(raw),
    token_prefix: raw.slice(0, 10),
    scopes: 'send,read',
    created_at,
  };
  insertStmt.run(record);
  return {
    token: raw,
    record: { ...record, active: 1, last_used_at: null } as ApiToken,
  };
}

export function listTokens(): ApiToken[] {
  return listStmt.all() as ApiToken[];
}

export function revokeToken(id: string): void {
  revokeStmt.run(id);
}

/**
 * Look up an active token by its plaintext value and record last-used time.
 * Returns the record if valid, otherwise undefined.
 */
export function verifyToken(raw: string): ApiToken | undefined {
  const row = findByHashStmt.get(hashToken(raw)) as ApiToken | undefined;
  if (!row) return undefined;
  touchStmt.run(new Date().toISOString(), row.id);
  return row;
}

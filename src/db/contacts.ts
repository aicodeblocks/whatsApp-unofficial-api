import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type ConsentStatus = 'opted_in' | 'unknown' | 'blocked';

export interface Contact {
  id: string;
  phone_number: string;
  display_name: string | null;
  consent_status: ConsentStatus;
  consent_source: string | null;
  first_contacted_at: string | null;
  last_contacted_at: string | null;
  created_at: string;
}

const getByPhoneStmt = db.prepare('SELECT * FROM contacts WHERE phone_number = ?');
const getByIdStmt = db.prepare('SELECT * FROM contacts WHERE id = ?');
const insertStmt = db.prepare(`
  INSERT INTO contacts (id, phone_number, created_at)
  VALUES (@id, @phone_number, @created_at)
`);
const touchContactedStmt = db.prepare(`
  UPDATE contacts
     SET last_contacted_at = @now,
         first_contacted_at = COALESCE(first_contacted_at, @now)
   WHERE id = @id
`);

const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM contacts');
const countByConsentStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM contacts WHERE consent_status = ?',
);

/** Total contacts, and a per-consent-status breakdown, for the Overview page. */
export function contactCounts(): { total: number; opted_in: number; blocked: number; unknown: number } {
  const total = (countAllStmt.get() as { n: number }).n;
  const count = (status: ConsentStatus) => (countByConsentStmt.get(status) as { n: number }).n;
  return {
    total,
    opted_in: count('opted_in'),
    blocked: count('blocked'),
    unknown: count('unknown'),
  };
}

export function getContactByPhone(phone: string): Contact | undefined {
  return getByPhoneStmt.get(phone) as Contact | undefined;
}

export function getContact(id: string): Contact | undefined {
  return getByIdStmt.get(id) as Contact | undefined;
}

/** Find an existing contact for this phone number or create a new (unknown) one. */
export function resolveContact(phone: string): Contact {
  const existing = getContactByPhone(phone);
  if (existing) return existing;
  const id = randomUUID();
  insertStmt.run({ id, phone_number: phone, created_at: new Date().toISOString() });
  return getContact(id)!;
}

/** Stamp the contact as just-contacted (sets first_contacted_at once). */
export function markContacted(id: string): void {
  touchContactedStmt.run({ id, now: new Date().toISOString() });
}

// --- Milestone 5: consent ---

const setConsentStmt = db.prepare(
  'UPDATE contacts SET consent_status = @status, consent_source = @source WHERE id = @id',
);

/** Record a consent decision (opted_in / blocked / unknown) and its source. */
export function setConsent(id: string, status: ConsentStatus, source: string | null): void {
  setConsentStmt.run({ id, status, source });
}

/** Ensure a contact row exists for a phone, then set its consent. Returns it. */
export function setConsentByPhone(phone: string, status: ConsentStatus, source: string | null): Contact {
  const contact = resolveContact(phone);
  setConsent(contact.id, status, source);
  return getContact(contact.id)!;
}

// --- v2 M3: contact import needs to set a display name ---

const setNameStmt = db.prepare('UPDATE contacts SET display_name = @name WHERE id = @id');

/** Set (or clear, with null) a contact's display name. */
export function updateContactName(id: string, name: string | null): void {
  setNameStmt.run({ id, name });
}

/**
 * List contacts, newest first, optionally filtered by a search string matching
 * the phone number or display name, and/or a consent status.
 */
export function listContacts(search?: string, status?: ConsentStatus, limit = 100): Contact[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (search && search.trim()) {
    where.push('(phone_number LIKE ? OR display_name LIKE ?)');
    const like = `%${search.trim()}%`;
    params.push(like, like);
  }
  if (status) {
    where.push('consent_status = ?');
    params.push(status);
  }
  const sql =
    `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}` +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as Contact[];
}

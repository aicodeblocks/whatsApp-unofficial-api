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

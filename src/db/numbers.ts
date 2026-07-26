import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type NumberStatus = 'connecting' | 'linked' | 'disconnected' | 'flagged';

export interface WhatsAppNumber {
  id: string;
  label: string;
  phone_number: string | null;
  status: NumberStatus;
  created_at: string;
  linked_at: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO whatsapp_numbers (id, label, status, created_at)
  VALUES (@id, @label, 'connecting', @created_at)
`);
const listStmt = db.prepare('SELECT * FROM whatsapp_numbers ORDER BY created_at ASC');
const getStmt = db.prepare('SELECT * FROM whatsapp_numbers WHERE id = ?');
const setStatusStmt = db.prepare('UPDATE whatsapp_numbers SET status = ? WHERE id = ?');
const setLinkedStmt = db.prepare(
  "UPDATE whatsapp_numbers SET status = 'linked', phone_number = ?, linked_at = ? WHERE id = ?",
);
const deleteStmt = db.prepare('DELETE FROM whatsapp_numbers WHERE id = ?');

export function createNumber(label: string): WhatsAppNumber {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  insertStmt.run({ id, label, created_at });
  return getNumber(id)!;
}

export function listNumbers(): WhatsAppNumber[] {
  return listStmt.all() as WhatsAppNumber[];
}

export function getNumber(id: string): WhatsAppNumber | undefined {
  return getStmt.get(id) as WhatsAppNumber | undefined;
}

export function setNumberStatus(id: string, status: NumberStatus): void {
  setStatusStmt.run(status, id);
}

export function setNumberLinked(id: string, phone: string | null): void {
  setLinkedStmt.run(phone, new Date().toISOString(), id);
}

export function deleteNumber(id: string): void {
  deleteStmt.run(id);
}

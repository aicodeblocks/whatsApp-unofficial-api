import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export interface ContactList {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface ContactListWithCount extends ContactList {
  member_count: number;
}

const insertListStmt = db.prepare(`
  INSERT INTO contact_lists (id, name, description, created_at)
  VALUES (@id, @name, @description, @now)
`);
const getListStmt = db.prepare('SELECT * FROM contact_lists WHERE id = ?');
const getListByNameStmt = db.prepare('SELECT * FROM contact_lists WHERE name = ?');
const listListsStmt = db.prepare(`
  SELECT l.*, COUNT(m.contact_id) AS member_count
    FROM contact_lists l
    LEFT JOIN contact_list_members m ON m.list_id = l.id
   GROUP BY l.id
   ORDER BY l.created_at DESC
`);

export function createList(name: string, description?: string | null): ContactList {
  const id = randomUUID();
  insertListStmt.run({ id, name, description: description ?? null, now: new Date().toISOString() });
  return getListStmt.get(id) as ContactList;
}

export function getList(id: string): ContactList | undefined {
  return getListStmt.get(id) as ContactList | undefined;
}

export function getListByName(name: string): ContactList | undefined {
  return getListByNameStmt.get(name) as ContactList | undefined;
}

/** Find a list by name, or create it — used by CSV import's "or type a new name" flow. */
export function findOrCreateList(name: string): ContactList {
  return getListByName(name) ?? createList(name);
}

export function listLists(): ContactListWithCount[] {
  return listListsStmt.all() as ContactListWithCount[];
}

const addMemberStmt = db.prepare(`
  INSERT OR IGNORE INTO contact_list_members (list_id, contact_id, added_at)
  VALUES (@list_id, @contact_id, @now)
`);
const removeMemberStmt = db.prepare(
  'DELETE FROM contact_list_members WHERE list_id = ? AND contact_id = ?',
);
const listsForContactStmt = db.prepare(`
  SELECT l.* FROM contact_lists l
  JOIN contact_list_members m ON m.list_id = l.id
   WHERE m.contact_id = ?
   ORDER BY l.name ASC
`);
const membersOfListStmt = db.prepare('SELECT contact_id FROM contact_list_members WHERE list_id = ?');

export function addContactToList(listId: string, contactId: string): void {
  addMemberStmt.run({ list_id: listId, contact_id: contactId, now: new Date().toISOString() });
}

export function removeContactFromList(listId: string, contactId: string): void {
  removeMemberStmt.run(listId, contactId);
}

export function listsForContact(contactId: string): ContactList[] {
  return listsForContactStmt.all(contactId) as ContactList[];
}

export function contactIdsInList(listId: string): string[] {
  return (membersOfListStmt.all(listId) as Array<{ contact_id: string }>).map((r) => r.contact_id);
}

// --- contact_imports: one row per CSV upload, for the result summary ---

export interface ContactImport {
  id: string;
  file_name: string;
  list_id: string;
  total_rows: number;
  imported_count: number;
  skipped_count: number;
  invalid_count: number;
  status: 'completed' | 'failed';
  created_at: string;
}

const insertImportStmt = db.prepare(`
  INSERT INTO contact_imports
    (id, file_name, list_id, total_rows, imported_count, skipped_count, invalid_count, status, created_at)
  VALUES (@id, @file_name, @list_id, @total_rows, @imported_count, @skipped_count, @invalid_count, @status, @now)
`);

export function recordImport(rec: Omit<ContactImport, 'id' | 'created_at'>): ContactImport {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertImportStmt.run({ id, now, ...rec });
  return db.prepare('SELECT * FROM contact_imports WHERE id = ?').get(id) as ContactImport;
}

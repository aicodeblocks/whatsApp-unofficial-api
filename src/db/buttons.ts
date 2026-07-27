import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export type ButtonType = 'quick_reply' | 'call' | 'link';
export type ButtonOwnerType = 'template' | 'message';

export interface Button {
  id: string;
  owner_type: ButtonOwnerType;
  owner_id: string;
  type: ButtonType;
  label: string;
  payload: string | null;
  sort_order: number;
}

export interface ButtonInput {
  type: ButtonType;
  label: string;
  payload?: string | null;
}

const VALID_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];
/** WhatsApp's classic buttons message tops out at 3 buttons. */
const MAX_BUTTONS = 3;

const deleteForOwnerStmt = db.prepare('DELETE FROM buttons WHERE owner_type = ? AND owner_id = ?');
const insertButtonStmt = db.prepare(`
  INSERT INTO buttons (id, owner_type, owner_id, type, label, payload, sort_order)
  VALUES (@id, @owner_type, @owner_id, @type, @label, @payload, @sort_order)
`);
const getForOwnerStmt = db.prepare(
  'SELECT * FROM buttons WHERE owner_type = ? AND owner_id = ? ORDER BY sort_order ASC',
);

/** Replace all buttons for an owner (template or message) with the given set. */
export function setButtonsFor(ownerType: ButtonOwnerType, ownerId: string, buttons: ButtonInput[]): void {
  deleteForOwnerStmt.run(ownerType, ownerId);
  const cleaned = buttons
    .filter((b) => VALID_TYPES.includes(b.type) && b.label && b.label.trim())
    .slice(0, MAX_BUTTONS);
  cleaned.forEach((b, i) => {
    insertButtonStmt.run({
      id: randomUUID(),
      owner_type: ownerType,
      owner_id: ownerId,
      type: b.type,
      label: b.label.trim().slice(0, 20), // WhatsApp button label limit
      payload: b.payload?.trim() || null,
      sort_order: i,
    });
  });
}

export function getButtonsFor(ownerType: ButtonOwnerType, ownerId: string): Button[] {
  return getForOwnerStmt.all(ownerType, ownerId) as Button[];
}

export function copyButtons(fromOwnerType: ButtonOwnerType, fromOwnerId: string, toOwnerType: ButtonOwnerType, toOwnerId: string): void {
  const source = getButtonsFor(fromOwnerType, fromOwnerId);
  setButtonsFor(
    toOwnerType,
    toOwnerId,
    source.map((b) => ({ type: b.type, label: b.label, payload: b.payload })),
  );
}

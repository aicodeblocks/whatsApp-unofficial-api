import { randomUUID } from 'node:crypto';
import { db } from './index.js';

export interface Group {
  id: string;
  number_id: string;
  provider_group_id: string;
  subject: string | null;
  participant_count: number;
  last_synced_at: string | null;
  created_at: string;
}

export interface SyncedGroup {
  jid: string;
  subject: string;
  participantCount: number;
}

const upsertStmt = db.prepare(`
  INSERT INTO groups (id, number_id, provider_group_id, subject, participant_count, last_synced_at, created_at)
  VALUES (@id, @number_id, @provider_group_id, @subject, @participant_count, @now, @now)
  ON CONFLICT(number_id, provider_group_id) DO UPDATE SET
    subject = excluded.subject,
    participant_count = excluded.participant_count,
    last_synced_at = excluded.last_synced_at
`);
const listForNumberStmt = db.prepare(
  'SELECT * FROM groups WHERE number_id = ? ORDER BY subject ASC',
);
const getStmt = db.prepare('SELECT * FROM groups WHERE id = ?');
const getByProviderIdStmt = db.prepare(
  'SELECT * FROM groups WHERE number_id = ? AND provider_group_id = ?',
);

/** Replace the known group list for a number with a freshly-synced set. */
export function upsertGroups(numberId: string, rows: SyncedGroup[]): void {
  const now = new Date().toISOString();
  const tx = db.transaction((groups: SyncedGroup[]) => {
    for (const g of groups) {
      upsertStmt.run({
        id: randomUUID(),
        number_id: numberId,
        provider_group_id: g.jid,
        subject: g.subject,
        participant_count: g.participantCount,
        now,
      });
    }
  });
  tx(rows);
}

export function listGroupsForNumber(numberId: string): Group[] {
  return listForNumberStmt.all(numberId) as Group[];
}

export function getGroup(id: string): Group | undefined {
  return getStmt.get(id) as Group | undefined;
}

/** Used to attach an inbound group message to a synced group, if we know it. */
export function getGroupByProviderId(numberId: string, jid: string): Group | undefined {
  return getByProviderIdStmt.get(numberId, jid) as Group | undefined;
}

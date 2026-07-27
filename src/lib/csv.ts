/**
 * Minimal CSV parser (RFC4180-ish): handles quoted fields, escaped quotes
 * ("") inside quotes, and commas/newlines inside quoted fields. No external
 * dependency — contact CSVs are small, simple, single-sheet exports.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // Flush the last field/row (files without a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const PHONE_HEADERS = ['phone', 'phone_number', 'mobile', 'number', 'whatsapp'];
const NAME_HEADERS = ['name', 'display_name', 'full_name', 'contact_name'];
const CONSENT_HEADERS = ['consent', 'consent_status', 'opt_in', 'opted_in'];

export interface ColumnMap {
  phoneIdx: number;
  nameIdx: number | null;
  consentIdx: number | null;
  hasHeader: boolean;
}

/** Auto-detects phone/name/consent columns by header name; falls back to
 *  "first column = phone" if no header matches anything recognized. */
export function detectColumns(rows: string[][]): ColumnMap {
  if (!rows.length) return { phoneIdx: 0, nameIdx: null, consentIdx: null, hasHeader: false };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (candidates: string[]) => header.findIndex((h) => candidates.includes(h));

  const phoneIdx = find(PHONE_HEADERS);
  const nameIdx = find(NAME_HEADERS);
  const consentIdx = find(CONSENT_HEADERS);

  if (phoneIdx === -1) {
    // No recognizable header row at all — treat every row as data, phone = column 0.
    return { phoneIdx: 0, nameIdx: nameIdx === -1 ? null : nameIdx, consentIdx: consentIdx === -1 ? null : consentIdx, hasHeader: false };
  }
  return { phoneIdx, nameIdx: nameIdx === -1 ? null : nameIdx, consentIdx: consentIdx === -1 ? null : consentIdx, hasHeader: true };
}

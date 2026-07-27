import type { ButtonInput, ButtonType } from '../db/buttons.js';

const BUTTON_TYPES: ButtonType[] = ['quick_reply', 'call', 'link'];

/** Collects up to 3 indexed button_type_N/button_label_N/button_payload_N form fields. */
export function collectButtons(body: Record<string, unknown>): ButtonInput[] {
  const out: ButtonInput[] = [];
  for (let i = 0; i < 3; i++) {
    const type = body[`button_type_${i}`] as ButtonType | undefined;
    const label = (body[`button_label_${i}`] as string | undefined)?.trim();
    if (!type || !BUTTON_TYPES.includes(type) || !label) continue;
    out.push({ type, label, payload: (body[`button_payload_${i}`] as string | undefined)?.trim() || null });
  }
  return out;
}

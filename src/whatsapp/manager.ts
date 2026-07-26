import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { config } from '../config.js';
import {
  createNumber,
  deleteNumber,
  getNumber,
  listNumbers,
  setNumberLinked,
  setNumberStatus,
  type NumberStatus,
  type WhatsAppNumber,
} from '../db/numbers.js';
import { advanceMessageStatus, getMessageByProviderId, type MessageStatus } from '../db/messages.js';
import { silentLogger } from './logger.js';

// Baileys ships as CommonJS with a default export. Loading it via createRequire
// avoids ESM/CJS interop pitfalls that differ between tsx and compiled Node ESM.
const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default as (opts: any) => any;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

interface LiveState {
  status: NumberStatus;
  /** Current QR as a PNG data-URI, present only while waiting to be scanned. */
  qr?: string;
  sock?: any;
  connecting?: boolean;
}

/** In-memory registry of live sockets, keyed by number id. */
const live = new Map<string, LiveState>();

function sessionDir(id: string): string {
  return resolve(config.dataDir, 'sessions', id);
}

function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  return jid.split(':')[0].split('@')[0] || null;
}

/** Turn a bare phone number (digits, optional +) into a WhatsApp user JID. */
export function phoneToJid(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Map Baileys' numeric/string message status onto our delivery states.
 * Baileys uses proto WAMessageStatus: 2=server-ack (sent), 3=delivery-ack,
 * 4=read, 5=played. Anything below server-ack is still "in flight".
 */
function mapProviderStatus(status: unknown): MessageStatus | null {
  const s = typeof status === 'string' ? status.toUpperCase() : status;
  switch (s) {
    case 2:
    case 'SERVER_ACK':
      return 'sent';
    case 3:
    case 'DELIVERY_ACK':
      return 'delivered';
    case 4:
    case 5:
    case 'READ':
    case 'PLAYED':
      return 'read';
    default:
      return null;
  }
}

function ensureState(id: string): LiveState {
  let st = live.get(id);
  if (!st) {
    st = { status: 'connecting' };
    live.set(id, st);
  }
  return st;
}

/**
 * Open (or re-open) a Baileys socket for a number, wiring the full connection
 * lifecycle: QR emission, link success, transient reconnects, and true logout.
 */
async function connect(id: string): Promise<void> {
  const st = ensureState(id);
  if (st.connecting) return;
  st.connecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(id));

  let version: unknown;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // fall back to Baileys' bundled version if offline
  }

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS('Chrome'),
    logger: silentLogger,
    markOnlineOnConnect: false, // don't force "online" — friendlier to the account
    syncFullHistory: false,
  });
  st.sock = sock;
  st.connecting = false;

  sock.ev.on('creds.update', saveCreds);

  // Outbound delivery/read status. Baileys reports acks against the message
  // key id we stored as provider_message_id when the message was sent.
  const onStatus = (updates: any[]) => {
    for (const u of updates ?? []) {
      const pid: string | undefined = u?.key?.id;
      const raw = u?.update?.status ?? u?.status;
      if (!pid || raw == null) continue;
      const mapped = mapProviderStatus(raw);
      if (!mapped) continue;
      const msg = getMessageByProviderId(pid);
      if (msg) advanceMessageStatus(msg.id, mapped);
    }
  };
  sock.ev.on('messages.update', onStatus);
  sock.ev.on('message-receipt.update', onStatus);

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        st.qr = await QRCode.toDataURL(qr, { margin: 1, width: 264 });
      } catch {
        st.qr = undefined;
      }
      st.status = 'connecting';
      if (getNumber(id)) setNumberStatus(id, 'connecting');
    }

    if (connection === 'open') {
      st.status = 'linked';
      st.qr = undefined;
      const phone = jidToPhone(sock.user?.id);
      if (getNumber(id)) setNumberLinked(id, phone);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      // If the number was deleted (unlink), stop here.
      if (!getNumber(id)) {
        live.delete(id);
        return;
      }

      if (loggedOut) {
        // WhatsApp invalidated the session — the operator must re-scan.
        st.status = 'disconnected';
        st.qr = undefined;
        setNumberStatus(id, 'disconnected');
        removeSession(id);
        st.sock = undefined;
      } else {
        // Transient drop (incl. the normal 515 "restart required" after pairing).
        st.status = 'connecting';
        setNumberStatus(id, 'connecting');
        st.sock = undefined;
        setTimeout(() => {
          connect(id).catch(() => {
            /* next reconnect attempt will be driven by a future close event */
          });
        }, 2000);
      }
    }
  });
}

function removeSession(id: string): void {
  const dir = sessionDir(id);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface NumberView extends WhatsAppNumber {
  /** QR data-URI when the number is waiting to be scanned. */
  qr: string | null;
}

/** Merge persisted rows with any live QR/status held in memory. */
function toView(row: WhatsAppNumber): NumberView {
  const st = live.get(row.id);
  return {
    ...row,
    status: st?.status ?? row.status,
    qr: st?.qr ?? null,
  };
}

export const whatsappManager = {
  /** Start sockets for all numbers that should be connected (called on boot). */
  async init(): Promise<void> {
    for (const row of listNumbers()) {
      if (row.status !== 'disconnected') {
        await connect(row.id).catch(() => {
          setNumberStatus(row.id, 'disconnected');
        });
      }
    }
  },

  /** Create a new number and begin the linking (QR) flow. */
  async addNumber(label: string): Promise<WhatsAppNumber> {
    const row = createNumber(label.trim() || 'Untitled number');
    ensureState(row.id).status = 'connecting';
    await connect(row.id).catch(() => setNumberStatus(row.id, 'disconnected'));
    return row;
  },

  /** Re-open the QR flow for a disconnected number without creating a new row. */
  async relink(id: string): Promise<void> {
    if (!getNumber(id)) return;
    removeSession(id);
    setNumberStatus(id, 'connecting');
    ensureState(id).status = 'connecting';
    await connect(id).catch(() => setNumberStatus(id, 'disconnected'));
  },

  /** Log out from WhatsApp, delete the session, and remove the number. */
  async unlink(id: string): Promise<void> {
    const st = live.get(id);
    // Remove the row first so the close handler knows this is an intentional unlink.
    deleteNumber(id);
    if (st?.sock) {
      try {
        await st.sock.logout();
      } catch {
        /* may already be disconnected */
      }
      try {
        st.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
    live.delete(id);
    removeSession(id);
  },

  list(): NumberView[] {
    return listNumbers().map(toView);
  },

  get(id: string): NumberView | undefined {
    const row = getNumber(id);
    return row ? toView(row) : undefined;
  },

  /** True only when the number has a live, opened socket ready to send. */
  isLinked(id: string): boolean {
    const st = live.get(id);
    return !!st && st.status === 'linked' && !!st.sock;
  },

  /** Drive the typing indicator ('composing' | 'paused') for the anti-ban engine. */
  async sendPresence(id: string, jid: string, state: 'composing' | 'paused'): Promise<void> {
    const sock = live.get(id)?.sock;
    if (!sock) return;
    try {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate(state, jid);
    } catch {
      /* presence is best-effort — never fail a send over it */
    }
  },

  /**
   * Send a message from a linked number. Returns WhatsApp's message id
   * (used as our provider_message_id). Throws if the number isn't linked.
   */
  async sendMessage(id: string, jid: string, content: Record<string, unknown>): Promise<string | null> {
    const st = live.get(id);
    if (!st || st.status !== 'linked' || !st.sock) {
      throw new Error('number_not_linked');
    }
    const sent = await st.sock.sendMessage(jid, content);
    return sent?.key?.id ?? null;
  },
};

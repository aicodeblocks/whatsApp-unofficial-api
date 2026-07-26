/**
 * The rule-based health / feedback engine (Milestone 5).
 *
 * It watches for danger signs — unexpected disconnects, re-login (logged-out)
 * prompts, and spikes in send failures / delivery drops — records them on the
 * per-number health timeline with an activity snapshot, and derives a live
 * health status (healthy → at_risk → flagged). When a number is flagged it is
 * put into a computed **cool-off** rest period (escalating with repeat
 * offences) during which the anti-ban queue holds it out of use and the
 * dashboard recommends switching to another number. Transitions are pushed to
 * the webhook so downstream systems learn about risk early.
 *
 * v1 is deliberately rule-based (no ML): it logs evidence for you to learn from.
 */
import {
  getNumber,
  inCooloff,
  setCooloffUntil,
  setHealthStatus,
  type HealthStatus,
} from '../db/numbers.js';
import {
  activitySnapshot,
  countEventsSince,
  insertHealthEvent,
  type HealthEventType,
  type Severity,
} from '../db/health.js';
import { emitHealth } from './webhooks.js';

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const healthCfg = {
  /** Trailing window (minutes) over which failures/disconnects are evaluated. */
  windowMin: num(process.env.HEALTH_WINDOW_MIN, 60),
  /** Minimum outbound volume in the window before a ratio is trusted. */
  minVolume: num(process.env.HEALTH_MIN_VOLUME, 5),
  /** Failure-ratio thresholds for at-risk and flagged. */
  atRiskRatio: num(process.env.HEALTH_ATRISK_RATIO, 0.3),
  flagRatio: num(process.env.HEALTH_FLAG_RATIO, 0.6),
  /** Unexpected disconnects in the window that tip a number to at-risk. */
  disconnectAtRisk: num(process.env.HEALTH_DISCONNECT_ATRISK, 3),
  /** Cool-off duration after a flag: base, doubling per repeat, capped. */
  cooloffBaseMin: num(process.env.HEALTH_COOLOFF_BASE_MIN, 60),
  cooloffMaxMin: num(process.env.HEALTH_COOLOFF_MAX_MIN, 1440),
  /** Look-back (minutes) for counting repeat cool-offs when escalating. */
  cooloffEscalateWindowMin: num(process.env.HEALTH_COOLOFF_ESCALATE_WINDOW_MIN, 7 * 1440),
} as const;

/** Multiplier the anti-ban queue applies to delays/limits while at-risk. */
export const AT_RISK_SLOWDOWN = num(process.env.HEALTH_ATRISK_SLOWDOWN, 3);

/** Record a raw danger signal, then re-evaluate the number's health. */
export function recordSignal(
  numberId: string,
  type: HealthEventType,
  severity: Severity,
  notes: string,
): void {
  const snapshot = activitySnapshot(numberId, healthCfg.windowMin);
  const event = insertHealthEvent({ number_id: numberId, event_type: type, severity, snapshot, notes });
  const status = getNumber(numberId)?.health_status ?? 'healthy';
  emitHealth(numberId, event, status);
  evaluateHealth(numberId);
}

/** Minutes of cool-off for the Nth flag (0-indexed) in the escalation window. */
function cooloffMinutesFor(priorCooloffs: number): number {
  const mins = healthCfg.cooloffBaseMin * 2 ** priorCooloffs;
  return Math.min(mins, healthCfg.cooloffMaxMin);
}

function humanDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return h === Math.floor(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

/**
 * Derive and apply the current health status from recent signals. Logs the
 * transition (with an activity snapshot) and fires a health webhook when the
 * status changes. Also lets a number recover once its cool-off has elapsed.
 */
export function evaluateHealth(numberId: string): HealthStatus {
  const number = getNumber(numberId);
  if (!number) return 'healthy';

  const now = new Date();
  const sinceISO = new Date(now.getTime() - healthCfg.windowMin * 60_000).toISOString();
  const snapshot = activitySnapshot(numberId, healthCfg.windowMin);

  const relogins = countEventsSince(numberId, 'relogin', sinceISO);
  const disconnects = countEventsSince(numberId, 'disconnect', sinceISO);
  const hasVolume = snapshot.outbound_total >= healthCfg.minVolume;

  // Decide the desired status from the rules.
  let desired: HealthStatus = 'healthy';
  if (relogins > 0 || (hasVolume && snapshot.failure_ratio >= healthCfg.flagRatio)) {
    desired = 'flagged';
  } else if (
    disconnects >= healthCfg.disconnectAtRisk ||
    (hasVolume && snapshot.failure_ratio >= healthCfg.atRiskRatio)
  ) {
    desired = 'at_risk';
  }

  const current = number.health_status;
  const resting = inCooloff(number, now);

  // While a flagged number is still resting, hold it there regardless of a
  // temporary lull in signals — the cool-off must run its course.
  if (current === 'flagged' && resting) return 'flagged';

  if (desired === 'flagged' && current !== 'flagged') {
    // New flag → open (or escalate) a cool-off rest period.
    const priorCooloffs = countEventsSince(
      numberId,
      'cooloff',
      new Date(now.getTime() - healthCfg.cooloffEscalateWindowMin * 60_000).toISOString(),
    );
    const mins = cooloffMinutesFor(priorCooloffs);
    const until = new Date(now.getTime() + mins * 60_000).toISOString();
    setHealthStatus(numberId, 'flagged');
    setCooloffUntil(numberId, until);
    const reason = relogins > 0 ? 'WhatsApp logged this number out (re-login prompt)' : 'high send-failure ratio';
    const notes =
      `Flagged: ${reason}. Cooling off for ${humanDuration(mins)} (until ${until}). ` +
      `Recommendation: stop using this number and route sends through a different linked number until the cool-off ends.`;
    const flagged = insertHealthEvent({ number_id: numberId, event_type: 'flagged', severity: 'critical', snapshot, notes });
    emitHealth(numberId, flagged, 'flagged', { cooloff_until: until, cooloff_minutes: mins, recommend_switch_number: true });
    insertHealthEvent({
      number_id: numberId,
      event_type: 'cooloff',
      severity: 'critical',
      snapshot,
      notes: `Cool-off started for ${humanDuration(mins)} (attempt #${priorCooloffs + 1}).`,
    });
    return 'flagged';
  }

  if (desired === 'at_risk' && current === 'healthy') {
    setHealthStatus(numberId, 'at_risk');
    const notes =
      disconnects >= healthCfg.disconnectAtRisk
        ? `At risk: ${disconnects} unexpected disconnect(s) in the last ${healthCfg.windowMin} min.`
        : `At risk: ${Math.round(snapshot.failure_ratio * 100)}% of recent sends failed. Sending will be slowed automatically.`;
    const ev = insertHealthEvent({ number_id: numberId, event_type: 'at_risk', severity: 'warning', snapshot, notes });
    emitHealth(numberId, ev, 'at_risk');
    return 'at_risk';
  }

  // Recovery: signals cleared and any cool-off has elapsed.
  if (desired === 'healthy' && current !== 'healthy' && !resting) {
    setHealthStatus(numberId, 'healthy');
    setCooloffUntil(numberId, null);
    const ev = insertHealthEvent({
      number_id: numberId,
      event_type: 'recovered',
      severity: 'info',
      snapshot,
      notes: 'Recovered: recent activity looks healthy again.',
    });
    emitHealth(numberId, ev, 'healthy');
    return 'healthy';
  }

  return current;
}

/**
 * Called by the queue before releasing a send: if a flagged number's cool-off
 * has elapsed, re-evaluate so it can recover. Returns the effective status.
 */
export function refreshHealth(numberId: string): HealthStatus {
  return evaluateHealth(numberId);
}

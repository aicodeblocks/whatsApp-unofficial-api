/**
 * A no-op logger that satisfies Baileys' pino-like Logger interface without
 * pulling in pino or spamming stdout. Baileys is very chatty at debug level;
 * we keep it silent by default.
 */
export const silentLogger: any = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger;
  },
};

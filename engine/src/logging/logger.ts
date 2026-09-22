import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/schema.js';

// Deliberately excludes bare "token" -- in a Solana bot every log line is
// full of legitimate domain terms (tokenMint, maxReentriesPerToken,
// tokenAgeSec) that would otherwise be false-positive redacted. Real
// secrets in this codebase are named privateKey/secretKey/seedPhrase/apiKey,
// or a more specific authToken/accessToken/bearerToken if one is ever added.
const SECRET_KEY_PATTERN = /(secret|private.?key|seed.?phrase|mnemonic|api.?key|auth.?token|access.?token|bearer.?token)/i;

const REDACTED = '[REDACTED]';

/**
 * Builds a redacted copy of a log field object -- never mutates the input,
 * since log payloads may reference frozen objects (e.g.
 * HARD_RISK_PARAMETERS) that would throw on an in-place write.
 */
function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

/**
 * `destination` is exposed for tests that need to inspect exactly what was
 * written (a pretty-print transport runs in a worker thread, which makes
 * synchronously asserting on output flaky). Runtime callers should omit it.
 */
export function createLogger(cfg: AppConfig['logging'], destination?: NodeJS.WritableStream): Logger {
  const options = {
    level: cfg.level,
    formatters: {
      log(object: Record<string, unknown>) {
        return redact(object) as Record<string, unknown>;
      },
    },
  };

  if (destination) {
    return pino(options, destination);
  }

  return pino({
    ...options,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
  });
}

export type { Logger };

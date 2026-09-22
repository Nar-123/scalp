/**
 * Secret hygiene for provider traffic. RPC and quote providers put credentials in places a log line is likely to
 * echo: a query parameter (`?api-key=...`), a URL path segment (some providers embed the token), or a header
 * (`x-api-key`, `Authorization`). Nothing in src/providers ever logs a URL or header verbatim: it logs
 * `redactUrl(url)` (scheme + host only) and passes free text through `redactSecrets`.
 */

const registered = new Set<string>();

/** Registers a secret value (API key, token embedded in a URL) so that any text containing it is scrubbed. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) registered.add(value);
}

/** Scheme + host only: no credentials, no path (a path may carry a token), no query. Unparseable input -> a constant. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid-url]';
  }
}

/** The secret-bearing part of an endpoint URL (query values and path), used to register it for scrubbing. */
export function secretsInUrl(raw: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(raw);
    for (const [, v] of u.searchParams) if (v.length >= 6) out.push(v);
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) out.push(seg);
    if (u.password) out.push(u.password);
    if (u.username && u.username.length >= 6) out.push(u.username);
  } catch {
    // not a URL
  }
  return out;
}

const PATTERNS: Array<[RegExp, string]> = [
  [/((?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|key)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(authorization["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of registered) out = out.split(secret).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Test helper: forget registered secrets. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

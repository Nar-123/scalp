import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging/logger.js';

function captureStream(): { stream: Writable; output: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, output: () => buffer };
}

describe('createLogger', () => {
  it('does not throw when logging a frozen object containing "Token" in a key name', () => {
    const frozen = Object.freeze({ maxReentriesPerToken: 5, positionSizeSol: 0.3 });
    const { stream } = captureStream();
    const logger = createLogger({ level: 'info' }, stream);
    expect(() => logger.info({ hardRisk: frozen }, 'startup')).not.toThrow();
  });

  it('redacts fields that look like real secrets without mutating the source object', () => {
    const secretHolder = { apiKey: 'sk-should-not-appear', privateKey: 'abc123', mint: 'So111...' };
    const { stream, output } = captureStream();
    const logger = createLogger({ level: 'info' }, stream);
    logger.info(secretHolder, 'test');

    expect(output()).not.toContain('sk-should-not-appear');
    expect(output()).not.toContain('abc123');
    expect(output()).toContain('So111...');
    expect(secretHolder.apiKey).toBe('sk-should-not-appear'); // source untouched
  });

  it('does not redact domain terms containing the substring "token"', () => {
    const { stream, output } = captureStream();
    const logger = createLogger({ level: 'info' }, stream);
    logger.info({ maxReentriesPerToken: 5, tokenAgeSec: 42 }, 'test');

    expect(output()).toContain('"maxReentriesPerToken":5');
    expect(output()).toContain('"tokenAgeSec":42');
  });
});

import { describe, expect, it } from 'vitest';
import { checkCircuitBreakerExit } from '../../../src/exit/conditions/circuitBreakerExit.js';

describe('checkCircuitBreakerExit', () => {
  it('does not trigger when the emergency stop is not active', () => {
    expect(checkCircuitBreakerExit(false)).toBe(false);
  });

  it('triggers when the emergency stop is active', () => {
    expect(checkCircuitBreakerExit(true)).toBe(true);
  });
});

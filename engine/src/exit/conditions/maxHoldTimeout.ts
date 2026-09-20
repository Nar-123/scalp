import type { AppConfig } from '../../config/schema.js';

export function checkMaxHoldTimeout(
  entryTimeMs: number,
  nowMs: number,
  cfg: Pick<AppConfig['exits'], 'maxHoldTimeSec'>,
): boolean {
  return (nowMs - entryTimeMs) / 1000 >= cfg.maxHoldTimeSec;
}

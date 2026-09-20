import type { AppConfig } from '../config/schema.js';

/**
 * Pure age-window filter. Inclusive of the min boundary, exclusive of the
 * max boundary (a token is "too old" the instant it reaches maxTokenAgeSec).
 */
export function isWithinAgeWindow(
  discoveredAtMs: number,
  nowMs: number,
  cfg: Pick<AppConfig['discovery'], 'minTokenAgeSec' | 'maxTokenAgeSec'>,
): boolean {
  if (!Number.isFinite(discoveredAtMs) || !Number.isFinite(nowMs)) return false;
  const ageSec = (nowMs - discoveredAtMs) / 1000;
  if (ageSec < 0) return false;
  return ageSec >= cfg.minTokenAgeSec && ageSec < cfg.maxTokenAgeSec;
}

export function tokenAgeSeconds(discoveredAtMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - discoveredAtMs) / 1000);
}

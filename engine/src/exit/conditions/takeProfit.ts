import type { AppConfig } from '../../config/schema.js';

export function checkQuickTakeProfit(pnlPct: number, cfg: Pick<AppConfig['exits'], 'quickTpMinPct'>): boolean {
  return pnlPct >= cfg.quickTpMinPct;
}

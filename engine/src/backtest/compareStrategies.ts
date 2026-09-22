import type { AppConfig } from '../config/schema.js';
import { runReplay } from './replayEngine.js';
import type { BacktestResult, HistoricalMarketSnapshot, SimulationAssumptions } from './types.js';

type StrategyConfig = Pick<AppConfig, 'discovery' | 'filters' | 'scoring' | 'exits' | 'reentry' | 'risk'>;

/**
 * A candidate is a full StrategyConfig plus a label -- never a partial patch
 * applied silently, so it's always obvious exactly which parameters a given
 * result reflects (spec task 15: "log which specific parameters differ").
 */
export interface StrategyCandidate {
  label: string;
  config: StrategyConfig;
}

export interface CandidateComparisonResult {
  parent: BacktestResult;
  candidates: BacktestResult[];
  /** Parameter-level diff of each candidate against the parent, for audit logging. */
  diffs: Array<{ label: string; changedFields: string[] }>;
}

/**
 * "Only permitted soft parameters may differ" (spec task 8, candidate
 * fairness): hard risk parameters cannot even be expressed in
 * StrategyConfig (see replayEngine.ts's use of HARD_RISK_PARAMETERS
 * directly, never taken from this config), so this diff can only ever
 * report differences in the tunable groups that were actually passed in --
 * there is no code path here through which a candidate could vary
 * position size, daily loss limit, max re-entries, or any other hard
 * parameter.
 */
function diffFields(parent: StrategyConfig, candidate: StrategyConfig): string[] {
  const changed: string[] = [];
  const groups = ['discovery', 'filters', 'scoring', 'exits', 'reentry', 'risk'] as const;
  for (const group of groups) {
    const parentJson = JSON.stringify(parent[group]);
    const candidateJson = JSON.stringify(candidate[group]);
    if (parentJson !== candidateJson) changed.push(group);
  }
  return changed;
}

/**
 * Runs the parent strategy and every candidate against the EXACT SAME
 * `snapshotsByMint` and `assumptions` (same historical period, same data,
 * same execution/fee/slippage/risk assumptions) -- candidate fairness is
 * structural here: there is only one snapshot set and one assumptions
 * object passed to runReplay for every candidate, not a per-candidate copy
 * that could silently drift.
 */
export function compareStrategies(
  snapshotsByMint: Map<string, HistoricalMarketSnapshot[]>,
  assumptions: SimulationAssumptions,
  parent: StrategyCandidate,
  candidates: StrategyCandidate[],
): CandidateComparisonResult {
  const parentResult = runReplay(snapshotsByMint, parent.config, assumptions, parent.label);
  const candidateResults = candidates.map((c) => runReplay(snapshotsByMint, c.config, assumptions, c.label));
  const diffs = candidates.map((c) => ({ label: c.label, changedFields: diffFields(parent.config, c.config) }));

  return { parent: parentResult, candidates: candidateResults, diffs };
}

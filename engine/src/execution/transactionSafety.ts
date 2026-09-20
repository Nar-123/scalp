import type { HardLimits } from '../risk/hardLimits.js';

export type { HardLimits };

/**
 * Pre-trade validation infrastructure (spec section 9 / Phase 2 task 9).
 * This is validation INFRASTRUCTURE for a future live executor -- nothing
 * in this file executes, signs, or broadcasts anything, and it is not
 * wired into the orchestrator in this phase. Every check is a pure
 * function so it can be tested exhaustively without a live RPC connection.
 */
export interface TransactionSafetyContext {
  /** The program the transaction is actually addressed to. */
  actualProgramId: string;
  expectedProgramId: string;
  /** e.g. 'buy' | 'sell' -- whatever the execution engine believes it's doing. */
  actualInstructionType: string;
  expectedInstructionType: string;
  actualMint: string;
  expectedMint: string;
  amountSol: number;
  estimatedSlippagePct: number;
  estimatedPriceImpactPct: number;
  /** Total SOL already committed to open positions, before this trade. */
  currentExposureSol: number;
  dailyCircuitBreakerTriggered: boolean;
  emergencyStopTriggered: boolean;
  dryRun: boolean;
  liveTradingExplicitlyEnabled: boolean;
}

export interface TransactionSafetyResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * Validates every condition spec section 9 names before a live transaction
 * could ever be allowed: destination/program, instruction type, mint,
 * amount, slippage, price impact, exposure, daily loss state, emergency
 * stop, and explicit live-mode configuration. Fails closed: `allowed` is
 * true only when every single check passes, and `reasons` lists every
 * failing check (not just the first), so a caller can log the full picture.
 */
export function validateTransactionSafety(ctx: TransactionSafetyContext, limits: HardLimits): TransactionSafetyResult {
  const reasons: string[] = [];

  if (ctx.dryRun) reasons.push('dry_run_active');
  if (!ctx.liveTradingExplicitlyEnabled) reasons.push('live_trading_not_explicitly_enabled');
  if (ctx.actualProgramId !== ctx.expectedProgramId) reasons.push('unexpected_program_id');
  if (ctx.actualInstructionType !== ctx.expectedInstructionType) reasons.push('unexpected_instruction_type');
  if (ctx.actualMint !== ctx.expectedMint) reasons.push('mint_mismatch');

  if (!Number.isFinite(ctx.amountSol) || ctx.amountSol <= 0 || ctx.amountSol > limits.maxAmountSol) {
    reasons.push('amount_out_of_bounds');
  }
  if (!Number.isFinite(ctx.estimatedSlippagePct) || ctx.estimatedSlippagePct > limits.maxSlippagePct) {
    reasons.push('slippage_exceeds_maximum');
  }
  if (!Number.isFinite(ctx.estimatedPriceImpactPct) || ctx.estimatedPriceImpactPct > limits.maxPriceImpactPct) {
    reasons.push('price_impact_exceeds_maximum');
  }
  if (!Number.isFinite(ctx.currentExposureSol) || ctx.currentExposureSol + ctx.amountSol > limits.maxExposureSol) {
    reasons.push('exposure_limit_exceeded');
  }
  if (ctx.dailyCircuitBreakerTriggered) reasons.push('daily_loss_circuit_breaker_triggered');
  if (ctx.emergencyStopTriggered) reasons.push('emergency_stop_triggered');

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Best-effort transaction simulation hook (spec section 9: "simulate where
 * supported"). Infrastructure only -- takes a generic simulate function so
 * it can be tested without a real @solana/web3.js Connection, and callers
 * decide what "simulate" means for their transaction type.
 */
export interface SimulationResult {
  ok: boolean;
  error?: string;
}

export async function simulateIfPossible(simulate: (() => Promise<SimulationResult>) | undefined): Promise<SimulationResult> {
  if (!simulate) {
    return { ok: false, error: 'simulation_not_supported' };
  }
  try {
    return await simulate();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

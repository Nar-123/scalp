import type { Connection } from '@solana/web3.js';
import type { JupiterQuoteClient } from './jupiterQuoteClient.js';
import type { Signer } from './signer/types.js';
import type { BuyParams, ExecutionEngine, FillResult, SellParams } from './types.js';

/**
 * Placeholder for real live execution. Deliberately unimplemented in this
 * pass -- wiring a real Signer (Windows Credential Manager), building and
 * simulating a Jupiter swap transaction, and submitting/confirming it is a
 * separate pass. The orchestrator must never select this class while
 * cfg.dryRun is true.
 */
export class LiveExecutorStub implements ExecutionEngine {
  constructor(
    private readonly signer: Signer,
    private readonly jupiterClient: JupiterQuoteClient,
    private readonly connection: Connection,
  ) {}

  async buy(_params: BuyParams): Promise<FillResult> {
    throw new Error('LiveExecutorStub.buy is not implemented in this pass. See docs/ARCHITECTURE.md roadmap.');
  }

  async sell(_params: SellParams): Promise<FillResult> {
    throw new Error('LiveExecutorStub.sell is not implemented in this pass. See docs/ARCHITECTURE.md roadmap.');
  }
}

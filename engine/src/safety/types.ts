import type { Connection } from '@solana/web3.js';
import type { AggregatorClient } from '../discovery/types.js';
import type { RoundTripQuote } from '../types/market.js';

export interface SafetyGateDeps {
  connection: Connection;
  aggregator: AggregatorClient;
  /** Fetches a buy+sell round-trip quote for sellability heuristics; injected so it can be mocked in tests. */
  getRoundTripQuote: (mint: string, testAmountSol: number) => Promise<RoundTripQuote | null>;
}

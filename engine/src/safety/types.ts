import type { Connection } from '@solana/web3.js';
import type { AggregatorClient } from '../discovery/types.js';
import type { RoundTripQuote } from '../types/market.js';
import type { SafetyDataSource } from './dataSource.js';

export interface SafetyGateDeps {
  connection: Connection;
  aggregator: AggregatorClient;
  /** Fetches a buy+sell round-trip quote for sellability heuristics; injected so it can be mocked in tests. */
  getRoundTripQuote: (mint: string, testAmountSol: number) => Promise<RoundTripQuote | null>;
  /** Phase 5.6A: where mint/holder data comes from (cached, deduplicated, failure-classified). Defaults to direct RPC reads. */
  data?: SafetyDataSource;
  /** Observability hook: the gate could not obtain `source` data for `reason` (provider vs token fact is in the reason prefix). */
  onUnavailable?: (source: 'mint' | 'holders' | 'vault' | 'liquidity' | 'quote', reason: string) => void;
}

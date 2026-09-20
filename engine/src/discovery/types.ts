import type { DiscoveredTokenEvent } from '../types/token.js';
import type { AggregatorHolderConcentration, AggregatorLiquidityVolume } from '../types/market.js';

export interface TokenDiscoverySource {
  readonly name: string;
  start(onEvent: (event: DiscoveredTokenEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface AggregatorClient {
  getLiquidityAndVolume(mint: string): Promise<AggregatorLiquidityVolume | null>;
  getHolderConcentration(mint: string): Promise<AggregatorHolderConcentration | null>;
  getPrice(mint: string): Promise<number | null>;
}

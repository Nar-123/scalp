export type DiscoverySource = 'raydium' | 'pumpfun';

export interface DiscoveredTokenEvent {
  mint: string;
  poolAddress: string | null;
  source: DiscoverySource;
  createdAtSlot: number;
  createdAtMs: number;
  initialLiquiditySol: number | null;
}

export interface MintAccountSummary {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
}

export interface HolderBalance {
  address: string;
  amount: bigint;
}

export interface HolderConcentrationInputs {
  largestAccounts: HolderBalance[];
  totalSupply: bigint;
  /** Addresses to exclude from concentration math (LP vaults, known burn addresses). */
  excludeAddresses: string[];
}

export type DiscoverySource = 'raydium' | 'pumpfun';

export interface DiscoveredTokenEvent {
  mint: string;
  poolAddress: string | null;
  source: DiscoverySource;
  createdAtSlot: number;
  createdAtMs: number;
  initialLiquiditySol: number | null;
  /** Wall-clock ms when THIS process first saw the event (optional; lets shadow measure real discovery latency = detectedAtMs - createdAtMs, on-chain blockTime has 1s resolution). */
  detectedAtMs?: number;
}

export interface MintAccountSummary {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  /**
   * Which token program owns the mint. Absent = classic SPL Token (every summary produced before Token-2022 support,
   * and every existing test fixture): the safety semantics for those are unchanged.
   */
  tokenProgram?: 'spl-token' | 'token-2022';
  /** Present only for Token-2022 mints: the decoded extensions, evaluated by checks/token2022ExtensionCheck.ts. */
  token2022?: { extensions: Array<{ id: number; name: string; data: Uint8Array }> };
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

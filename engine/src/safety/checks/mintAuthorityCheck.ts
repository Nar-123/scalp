import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { MintAccountSummary } from '../../types/token.js';

export async function fetchMintAccountSummary(connection: Connection, mint: string): Promise<MintAccountSummary | null> {
  try {
    const pubkey = new PublicKey(mint);
    const mintInfo = await getMint(connection, pubkey);
    return {
      mint,
      mintAuthority: mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : null,
      freezeAuthority: mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toBase58() : null,
      supply: mintInfo.supply,
      decimals: mintInfo.decimals,
    };
  } catch {
    return null;
  }
}

export function evaluateMintAuthority(summary: MintAccountSummary | null): { passed: boolean; reason?: string } {
  if (!summary) return { passed: false, reason: 'mint_account_unavailable' };
  if (summary.mintAuthority !== null) {
    return { passed: false, reason: 'mint_authority_not_renounced' };
  }
  return { passed: true };
}

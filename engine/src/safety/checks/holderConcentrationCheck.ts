import { Connection, PublicKey } from '@solana/web3.js';
import type { HolderBalance, HolderConcentrationInputs } from '../../types/token.js';

export async function fetchLargestHolders(connection: Connection, mint: string): Promise<HolderBalance[] | null> {
  try {
    const resp = await connection.getTokenLargestAccounts(new PublicKey(mint));
    return resp.value.map((v) => ({ address: v.address.toBase58(), amount: BigInt(v.amount) }));
  } catch {
    return null;
  }
}

export function evaluateHolderConcentration(
  inputs: HolderConcentrationInputs,
  maxTop10Pct: number,
): { passed: boolean; top10Pct: number; reason?: string } {
  if (inputs.totalSupply <= 0n) {
    return { passed: false, top10Pct: 0, reason: 'invalid_supply' };
  }
  const excluded = new Set(inputs.excludeAddresses);
  const relevant = inputs.largestAccounts.filter((h) => !excluded.has(h.address)).slice(0, 10);
  const totalHeld = relevant.reduce((sum, h) => sum + h.amount, 0n);
  // basis-points-of-a-percent precision, then scale down to a plain percentage
  const top10PctHundredths = (totalHeld * 10_000n) / inputs.totalSupply;
  const top10Pct = Number(top10PctHundredths) / 100;

  if (top10Pct > maxTop10Pct) {
    return { passed: false, top10Pct, reason: 'holder_concentration_too_high' };
  }
  return { passed: true, top10Pct };
}

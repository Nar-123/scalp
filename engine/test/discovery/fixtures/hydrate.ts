import { PublicKey } from '@solana/web3.js';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';

/**
 * The captured fixtures are plain JSON (base58 strings). The real detector
 * functions call `.toBase58()` on account/program fields (matching what
 * @solana/web3.js's getParsedTransaction actually returns), so tests
 * rehydrate those strings into real PublicKey instances rather than mocking
 * the interface -- this exercises the exact same code path production runs.
 */
export function hydrateParsedTransaction(raw: unknown): ParsedTransactionWithMeta {
  const tx = raw as any;

  const hydrateIx = (ix: any) => {
    if ('data' in ix) {
      return { programId: new PublicKey(ix.programId), accounts: ix.accounts.map((a: string) => new PublicKey(a)), data: ix.data };
    }
    return { programId: new PublicKey(ix.programId), program: ix.program, parsed: ix.parsed };
  };

  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    transaction: {
      message: {
        accountKeys: tx.transaction.message.accountKeys.map((k: any) => ({
          pubkey: new PublicKey(k.pubkey),
          signer: k.signer,
          writable: k.writable,
        })),
        instructions: tx.transaction.message.instructions.map(hydrateIx),
      },
    },
    meta: {
      preTokenBalances: tx.meta.preTokenBalances,
      postTokenBalances: tx.meta.postTokenBalances,
      innerInstructions: tx.meta.innerInstructions.map((group: any) => ({
        index: group.index,
        instructions: group.instructions.map(hydrateIx),
      })),
    },
  } as unknown as ParsedTransactionWithMeta;
}

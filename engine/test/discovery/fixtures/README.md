# Real mainnet transaction fixtures (Phase 1.1 discovery validation)

Captured live from `api.mainnet-beta.solana.com` during Phase 1.1. Each file
is a trimmed `getParsedTransaction` response (only the fields the detectors
in `src/discovery/creationDetector.ts` actually read: account keys with
signer flags, top-level + inner instructions, pre/post token balances).

| File | Signature | What it is | Expected verdict |
|---|---|---|---|
| `pumpfun_create_v2_top_level.json` | `2SJ4YrWb5rHaa9cPCCmH22GyWfEUudu4AFdQ4TB6FKTYe2qxkdTDnnyb9a4ipoVXqV1oQ9ZHM2Sfm1VLRDgad4aM` | Genuine pump.fun token creation. Top-level `CreateV2` instruction directly on the pump.fun program; instruction data's first 8 bytes exactly match the `create_v2` discriminator read from pump.fun's own on-chain Anchor IDL; account 0 (`MAP8KCX3mbsCXUTrMhbbTr54urw5Cy48hbaxpPjpump`) is both the new mint and a transaction signer; that mint has no preTokenBalance entry (didn't exist before this tx) and a postTokenBalance entry (exists after). | **ACCEPT** (pump.fun) |
| `pumpfun_create_v2_nested_bundler.json` | `3FwawFnc5XibGdFBHtT4WCdLbD4EdSJgASQWrZxJrzofx9Ruc6rECDXZLrQg7FbMKLCyXbdiGL9856ehZX6YkVX9` | Genuine pump.fun token creation submitted through a third-party bundler/launchpad program (`6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB`, instruction `CreateCoinAndBuyBondingCurveV3`) that CPIs into pump.fun's `CreateV2` at invoke depth 2, immediately followed by a `BuyExactQuoteInV2` (the classic "dev buy"). The `CreateV2` call is a **nested inner instruction**, not top-level -- this fixture is why detection must scan `meta.innerInstructions`, not just `transaction.message.instructions`. Inner instructions also show the literal `system.createAccount` + `spl-token.initializeMint2` for the new mint. This same transaction also contains a real, nested Raydium AMM V4 call (tag `9`, `SwapBaseIn`) unrelated to pool creation -- reused in Phase 1.1.1 as a real-data REJECT case for `detectRaydiumAmmV4PoolCreation`. | **ACCEPT** (pump.fun) / **REJECT** (Raydium -- it's a swap, not `initialize2`) |
| `ordinary_swap_aggregator_buy.json` | `pxJTGcAJ6UZLij58k5e2fP6FW5mzVbvXN32fm9sJ6h2tYt3GKMy9w8CQ4sU5mGaewogVjBaBZjdova2zkTKASsj` | An ordinary Buy on an **existing** pump.fun token, routed through a DEX aggregator (`G7MVcM9YzGxrmLtmobUgyt8A6WhQ2dgQX3aSJcPejdEp`, instruction `Swap`), which CPIs into pump.fun's `Buy` instruction. Captured originally in Phase 1 because a naive whole-transaction substring search for `"Instruction: Create"` misfired on it (an unrelated instruction, `CreateTokenAccountWithSeed`, appears elsewhere in the same transaction's logs). The traded mint (`2KHDu6EcjtwopUfw6g385DEY4kdYDbQwErfbNLLkpump`) already appears in `preTokenBalances`, i.e. it's not new. | **REJECT** |
| `unrelated_transfer.json` | `5GSeC7BmtdQPLDPKR9MwLUiub27ZFuYtMNtQtn8jjHZNBAgYYa8EwALf9xdJpPtoNUdcB1nZnhfvyXgm95ntfpF6` | A plain wallet-to-wallet SOL transfer (`system.transfer`). Never mentions pump.fun or Raydium at all. | **REJECT** (no evidence for either program) |

No genuine Raydium AMM V4 `initialize2` (pool creation) transaction is
included here -- none could be captured across two separate passes despite
repeated attempts (public-RPC rate limits and the rarity of real pool
creations both contributed). See `docs/PHASE_1_1_DISCOVERY_VALIDATION.md`
and `docs/PHASE_1_1_1_RAYDIUM_HARDENING.md` for what was tried and why
`detectRaydiumAmmV4PoolCreation()`'s "valid initialize2" test case is a
clearly-labeled **synthetic** transaction (built to match the documented
account layout exactly) rather than a captured real one, and why detection
requires the tag match, the full account-layout validation, a genuinely
fresh LP mint at the canonical position, AND a signing user wallet all
independently -- so a wrong assumption about any single piece (the tag
value, the account ordering) fails closed instead of misfiring.

"Malformed/incomplete transaction" test cases are constructed directly in
the test file rather than captured, since a transaction malformed enough to
matter (missing `meta`, empty instruction lists, `null` from a failed RPC
fetch) by definition cannot be "captured" -- a real RPC only ever returns a
complete, successfully parsed transaction or `null`.

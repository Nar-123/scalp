import { z } from 'zod';

export const ConfigSchema = z.object({
  dryRun: z.boolean().default(true),
  strategyVersion: z.string().min(1).default('baseline-v1'),

  rpc: z.object({
    httpUrl: z.string().url(),
    wsUrl: z.string().url(),
  }),

  aggregators: z
    .object({
      birdeyeApiKey: z.string().optional(),
      dexscreenerBaseUrl: z.string().url().default('https://api.dexscreener.com'),
      jupiterQuoteBaseUrl: z.string().url().default('https://lite-api.jup.ag/swap/v1'),
      requestTimeoutMs: z.number().int().positive().default(4000),
    })
    .default({}),

  discovery: z
    .object({
      minTokenAgeSec: z.number().nonnegative().default(30),
      maxTokenAgeSec: z.number().positive().default(15 * 60),
      raydiumProgramId: z.string().default('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
      pumpFunProgramId: z.string().default('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    })
    .default({}),

  filters: z
    .object({
      minLiquiditySol: z.number().nonnegative().default(20),
      minVolume1mSol: z.number().nonnegative().default(5),
      minBuySellRatio: z.number().nonnegative().default(1.5),
      minPriceVelocity5sPct: z.number().default(1),
      minVolumeAccelerationX: z.number().nonnegative().default(1.5),
      maxPriceImpactPct: z.number().nonnegative().default(1),
    })
    .default({}),

  scoring: z
    .object({
      weights: z
        .object({
          momentum: z.number().default(1),
          volume: z.number().default(1),
          buyPressure: z.number().default(1),
          txVelocity: z.number().default(0.5),
          liquidityQuality: z.number().default(1),
          slippageRisk: z.number().default(1),
          priceImpactRisk: z.number().default(1),
        })
        .default({}),
      minEntryScore: z.number().default(3),
    })
    .default({}),

  edge: z
    .object({
      dexFeeBps: z.number().nonnegative().default(25),
      swapFeeBps: z.number().nonnegative().default(5),
      networkFeeSol: z.number().nonnegative().default(0.000005),
      priorityFeeSol: z.number().nonnegative().default(0.0005),
      safetyMarginBps: z.number().nonnegative().default(50),
    })
    .default({}),

  exits: z
    .object({
      quickTpMinPct: z.number().positive().default(2),
      quickTpMaxPct: z.number().positive().default(3),
      momentumTpMinPct: z.number().positive().default(4),
      momentumTpMaxPct: z.number().positive().default(6),
      dynamicSlMinPct: z.number().positive().default(2),
      dynamicSlMaxPct: z.number().positive().default(3),
      trailingActivationPct: z.number().positive().default(3),
      trailingDistancePct: z.number().positive().default(1.5),
      maxHoldTimeSec: z.number().positive().default(30),
      liquidityDeteriorationPct: z.number().positive().default(30),
      reversalDropFromPeakPct: z.number().positive().default(2),
    })
    .default({}),

  risk: z
    .object({
      // In DRY_RUN there's no real wallet to read a balance from. A live
      // pass should replace this with the actual on-chain wallet SOL
      // balance at each UTC day's start.
      dailyStartingBalanceSol: z.number().positive().default(10),
    })
    .default({}),

  reentry: z
    .object({
      cooldownMs: z.number().nonnegative().default(60_000),
      consecutiveLossLimit: z.number().int().positive().default(2),
    })
    .default({}),

  safety: z
    .object({
      maxTop10HolderPct: z.number().positive().default(60),
      excludeAddresses: z.array(z.string()).default([]),
      // Phase 5.6E safeguards for the verified-vault holder policy. 0 = OFF: no new policy threshold is set by default.
      minCirculatingSharePct: z.number().min(0).max(100).default(0),
      minVisibleHolders: z.number().int().nonnegative().default(0),
    })
    .default({}),

  execution: z
    .object({
      latencySlippageBufferPct: z.number().nonnegative().default(0.3),
      fallbackPriceImpactPct: z.number().nonnegative().default(1),
      // Second, independent switch required (in addition to dryRun=false)
      // before any real signature/broadcast may occur -- see
      // DryRunGuardedSigner. Never set true by inferring it from anything
      // else; must be an explicit, deliberate operator choice.
      liveTradingExplicitlyEnabled: z.boolean().default(false),
      walletCredentialPath: z.string().optional(),
    })
    .default({}),

  shadow: z
    .object({
      // Read-only realtime shadow trading (Phase 5/5.1). Default OFF: with it off
      // no ShadowRunner exists and behavior is identical to before the flag.
      // Enabling it never enables signing, sending, or live execution.
      enabled: z.boolean().default(false),
    })
    .default({}),

  volume: z
    .object({
      // Phase 5.4B: native Pump.fun 1-minute SOL volume from the shared trade-event stream.
      // Read-only chain data; nothing here signs or sends. Off => volume1mSol stays null (unavailable).
      pumpfunNativeEnabled: z.boolean().default(true),
      recordTradeEvents: z.boolean().default(true),
      tradeEventRetentionHours: z.number().positive().default(24),
      streamSilenceMs: z.number().int().positive().default(5000),
      // Phase 5.5: native bonding-curve market data (price, liquidity, exact price impact) as the PRIMARY source for
      // Pump.fun tokens. Off => the Phase 5.4B behavior (DexScreener market data, native volume only).
      nativeMarketEnabled: z.boolean().default(true),
      // Largest tolerated gap (event seconds) between the price/liquidity as-of second and the volume window end,
      // AND (P1 fix) between a token's own last curve-changing trade and the stream watermark -- see
      // PumpfunVolumeEngineOptions.maxSnapshotSkewSec. Default 5 (existing, unchanged production value).
      nativeMaxSnapshotSkewSec: z.number().int().positive().default(5),
      // Default false: a Pump.fun curve token whose native state is unprovable is market_data_unavailable, not silently priced by DexScreener.
      dexscreenerFallbackForCurveTokens: z.boolean().default(false),
    })
    .default({}),

  // Phase 5.6A: provider request discipline. Endpoints themselves stay in `rpc.*` and `aggregators.*` (env
  // SOLANA_RPC_URL / SOLANA_RPC_WS_URL / JUPITER_BASE_URL, with the older RPC_HTTP_URL / RPC_WS_URL /
  // JUPITER_QUOTE_BASE_URL still honored). Credentials come only from the environment and are never logged.
  providers: z
    .object({
      rpc: z
        .object({
          apiKey: z.string().optional(),
          fallbackUrls: z.array(z.string().url()).default([]),
          // P1 credential-isolation fix: index-aligned with fallbackUrls. An empty/missing entry for a given
          // fallback means that endpoint gets NO credential -- it never automatically inherits `apiKey`, which is
          // the primary endpoint's alone. Deliberately NOT validated to be the same length as fallbackUrls: a
          // short/empty array (the default, and every existing single-primary deployment) just means every
          // fallback has no credential, which is exactly the safe default.
          fallbackApiKeys: z.array(z.string()).default([]),
          timeoutMs: z.number().int().positive().default(4000),
          maxConcurrent: z.number().int().positive().default(4),
          maxRequestsPerSecond: z.number().positive().default(8),
          maxRetries: z.number().int().nonnegative().default(2),
          baseBackoffMs: z.number().int().positive().default(250),
          maxBackoffMs: z.number().int().positive().default(2000),
          maxTotalMs: z.number().int().positive().default(8000),
          circuitFailureThreshold: z.number().int().positive().default(5),
          circuitCooldownMs: z.number().int().positive().default(15_000),
          unsupportedCooldownMs: z.number().int().positive().default(600_000),
          // Mint / holder data may be reused this long at most (hard cap 10 s = the decision staleness bound).
          safetyDataTtlMs: z.number().int().nonnegative().max(10_000).default(10_000),
        })
        .default({}),
      quote: z
        .object({
          apiKey: z.string().optional(),
          fallbackUrls: z.array(z.string().url()).default([]),
          // Same isolation rule as providers.rpc.fallbackApiKeys, for the quote (Jupiter) fallbacks.
          fallbackApiKeys: z.array(z.string()).default([]),
          timeoutMs: z.number().int().positive().default(4000),
          maxConcurrent: z.number().int().positive().default(4),
          maxRequestsPerSecond: z.number().positive().default(4),
          maxRetries: z.number().int().nonnegative().default(2),
          baseBackoffMs: z.number().int().positive().default(300),
          maxBackoffMs: z.number().int().positive().default(2500),
          maxTotalMs: z.number().int().positive().default(8000),
          circuitFailureThreshold: z.number().int().positive().default(5),
          circuitCooldownMs: z.number().int().positive().default(15_000),
          unsupportedCooldownMs: z.number().int().positive().default(600_000),
          // An identical quote may be reused this long at most (hard cap 10 s).
          cacheTtlMs: z.number().int().nonnegative().max(10_000).default(2000),
        })
        .default({}),
      metricsLogIntervalMs: z.number().int().nonnegative().default(60_000),
      /** Upper bound for each step of the shutdown sequence. */
      shutdownStepTimeoutMs: z.number().int().positive().default(4000),
    })
    .default({}),

  ledger: z
    .object({
      dbPath: z.string().default('./data/ledger.sqlite'),
    })
    .default({}),

  logging: z
    .object({
      level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

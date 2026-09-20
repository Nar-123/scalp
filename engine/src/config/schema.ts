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
      jupiterQuoteBaseUrl: z.string().url().default('https://quote-api.jup.ag/v6'),
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

// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The one rule that matters architecturally here: HARD_RISK_PARAMETERS
 * (src/config/hardRisk.ts) must never be imported by anything outside the
 * deterministic engine's own config/risk/orchestrator wiring -- specifically
 * never by a future AI/learning module. Everything else is left permissive
 * for this pass.
 *
 * src/backtest/** is exempted starting Phase 3-alt: the historical replay
 * engine is deterministic, non-AI code that MUST reuse the exact same
 * HARD_RISK_PARAMETERS the live orchestrator uses (spec requirement: no
 * separate/incompatible risk implementation for backtesting). This is a
 * different concern from the Python learning/ package, which never imports
 * this file at all (it is a different language and reads the ledger only).
 *
 * src/shadow/** is exempted starting Phase 5 for the same reason as
 * src/backtest/**: realtime shadow trading is deterministic, non-AI code
 * that must reuse the exact same HARD_RISK_PARAMETERS the live orchestrator
 * uses, never a separate/incompatible risk implementation.
 */
const hardRiskRestriction = {
  files: ['src/**/*.ts'],
  ignores: ['src/config/**', 'src/risk/**', 'src/orchestrator/**', 'src/index.ts', 'src/backtest/**', 'src/shadow/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/config/hardRisk.js', '**/config/hardRisk'],
            message:
              'HARD_RISK_PARAMETERS must stay isolated to config/, risk/, and the orchestrator. If this is a new AI/learning module, it must never import hard risk parameters directly.',
          },
        ],
      },
    ],
  },
};

/**
 * Phase 5 safety rule: src/shadow/** (realtime shadow trading) must NEVER
 * be able to sign or broadcast a transaction, even if a wallet credential
 * happens to be configured on the machine. Structurally enforced by
 * blocking every import of the signer subsystem from shadow code -- there
 * is no code path through which shadow could obtain a Signer/SecretProvider
 * even by mistake. See test/shadow/noWalletAccess.test.ts for the runtime
 * proof (a real KeypairSigner is constructed and spied on in the test
 * process; the shadow pipeline never calls it).
 */
const shadowNoSignerRestriction = {
  files: ['src/shadow/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/execution/signer/**'],
            message:
              'src/shadow/** must never import anything from execution/signer/** -- shadow trading must be structurally incapable of signing or broadcasting a transaction.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  hardRiskRestriction,
  shadowNoSignerRestriction,
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

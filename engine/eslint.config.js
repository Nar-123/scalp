// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The one rule that matters architecturally here: HARD_RISK_PARAMETERS
 * (src/config/hardRisk.ts) must never be imported by anything outside the
 * deterministic engine's own config/risk/orchestrator wiring -- specifically
 * never by a future AI/learning module. Everything else is left permissive
 * for this pass.
 */
const hardRiskRestriction = {
  files: ['src/**/*.ts'],
  ignores: ['src/config/**', 'src/risk/**', 'src/orchestrator/**', 'src/index.ts'],
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

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  hardRiskRestriction,
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

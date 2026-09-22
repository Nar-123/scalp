import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { KeypairSigner } from '../../src/execution/signer/keypairSigner.js';
import type { SecretProvider } from '../../src/execution/signer/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

const SHADOW_SRC_DIR = join(__dirname, '..', '..', 'src', 'shadow');

describe('shadow mode + available wallet credential => NO SIGNATURE, NO BROADCAST', () => {
  it('never touches a real, available signer while running a full entry/exit cycle', async () => {
    // A wallet credential genuinely "exists on the machine": a working
    // SecretProvider backing a real KeypairSigner, with every method spied.
    const secret = bs58.encode(Keypair.generate().secretKey);
    const secretProvider: SecretProvider = {
      isAvailable: vi.fn(async () => true),
      getSecretBase58: vi.fn(async () => secret),
    };
    const signer = new KeypairSigner(secretProvider);
    const signSpy = vi.spyOn(signer, 'signTransaction');
    const pubKeySpy = vi.spyOn(signer, 'getPublicKey');
    expect(await signer.isAvailable()).toBe(true);
    (secretProvider.isAvailable as ReturnType<typeof vi.fn>).mockClear();

    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: 'V1', config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });

    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 1.03 }));

    expect(ledger.getAllClosedTrades('V1')).toHaveLength(1); // the shadow pipeline really ran
    expect(signSpy).not.toHaveBeenCalled();
    expect(pubKeySpy).not.toHaveBeenCalled();
    expect(secretProvider.getSecretBase58).not.toHaveBeenCalled();
    expect(secretProvider.isAvailable).not.toHaveBeenCalled();
  });

  it('exposes no constructor option or public member through which a signer could be supplied', () => {
    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [], assumptions: DEFAULT_ASSUMPTIONS });
    const surface = [...Object.getOwnPropertyNames(runner), ...Object.getOwnPropertyNames(Object.getPrototypeOf(runner))].join(' ').toLowerCase();
    expect(surface).not.toMatch(/sign|wallet|secret|keypair|broadcast|sendtransaction/);
  });

  it('shadow source files never reference the signer subsystem or transaction broadcasting', () => {
    const files = readdirSync(SHADOW_SRC_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(SHADOW_SRC_DIR, file), 'utf8');
      // Only look at import specifiers and call sites, not prose in comments.
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
        .join('\n');
      expect(code, file).not.toMatch(/execution\/signer/);
      expect(code, file).not.toMatch(/KeypairSigner|WindowsDpapi|DryRunGuardedSigner/);
      expect(code, file).not.toMatch(/sendRawTransaction|sendTransaction|signTransaction|simulateTransaction/);
    }
  });
});

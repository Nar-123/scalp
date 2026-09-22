import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { SecretProvider } from './types.js';

/**
 * Windows DPAPI-backed secret storage -- the "OS keychain / external secret
 * manager" chosen for this project. DPAPI ties the encrypted blob to the
 * current Windows user account (and machine, by default), so the ciphertext
 * on disk is useless without that account's login session; nothing here
 * requires a native Node addon (no node-gyp build step), which this project
 * specifically avoids (see docs/ARCHITECTURE.md's node:sqlite rationale --
 * this machine has no Visual Studio Build Tools installed, so a `keytar`-
 * style native Credential Manager binding was rejected for the same reason).
 *
 * This class is standalone infrastructure: nothing in the orchestrator or
 * index.ts constructs or wires it up. It exists to be used by a future
 * LiveExecutor pass, gated behind DryRunGuardedSigner regardless.
 */
export class WindowsDpapiSecretProvider implements SecretProvider {
  constructor(private readonly protectedFilePath: string) {}

  async isAvailable(): Promise<boolean> {
    return existsSync(this.protectedFilePath);
  }

  /**
   * Decrypts the DPAPI-protected file and returns its plaintext contents
   * (expected to be a base58-encoded Solana secret key). Never writes the
   * plaintext to disk, stdout of a logger, or any error message -- only the
   * in-memory return value carries it, captured directly from the child
   * process's stdout pipe.
   */
  async getSecretBase58(): Promise<string> {
    if (!(await this.isAvailable())) {
      throw new Error(`No protected credential file found at the configured path. Run protectAndStore() first.`);
    }
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$encrypted = Get-Content -Path $env:SCALP_DPAPI_PATH -Raw`,
      '$secure = ConvertTo-SecureString -String $encrypted',
      '$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
      // try/finally must stay one statement -- joining it across ';'-separated
      // array elements (as every other line here is joined) breaks
      // PowerShell's parser ("Try statement is missing its Catch or Finally
      // block"), since a semicolon between the try block and `finally`
      // splits them into two statements instead of one construct.
      'try { [Console]::Out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
    ].join('; ');

    const plaintext = await runPowerShell(script, { SCALP_DPAPI_PATH: this.protectedFilePath });
    const trimmed = plaintext.trim();
    if (!trimmed) {
      throw new Error('Decrypted credential was empty -- refusing to hand back an empty secret.');
    }
    return trimmed;
  }

  /**
   * One-time setup helper: encrypts `secretBase58` with DPAPI and writes the
   * ciphertext to `protectedFilePath`. Intended to be run once, manually, by
   * the operator (e.g. from a setup script) -- the trading engine itself
   * never calls this. The plaintext is piped over stdin, never passed as a
   * command-line argument (which would otherwise be visible via process
   * listings) and never logged by this function.
   */
  static async protectAndStore(secretBase58: string, protectedFilePath: string): Promise<void> {
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$plain = [Console]::In.ReadToEnd()',
      '$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force',
      '$encrypted = $secure | ConvertFrom-SecureString',
      'Set-Content -Path $env:SCALP_DPAPI_PATH -Value $encrypted -NoNewline',
    ].join('; ');

    await runPowerShell(script, { SCALP_DPAPI_PATH: protectedFilePath }, secretBase58);
  }
}

function runPowerShell(script: string, env: Record<string, string>, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        // stderr from a failed PowerShell decrypt could theoretically echo
        // back part of the script but never the secret itself (the secret
        // is never placed in the script text or command-line arguments).
        reject(new Error(`powershell.exe exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin, 'utf8');
    }
    child.stdin.end();
  });
}

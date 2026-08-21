import { describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { parseAuthStatus } from '../../src/auth/auth-status.js';
import type { ProcessResult } from '../../src/codex/process-runner.js';
import { CodexMcpError } from '../../src/errors/codex-mcp-error.js';

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 1,
    spawnFailed: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

describe('parseAuthStatus', () => {
  it('recognizes a ChatGPT session', () => {
    const status = parseAuthStatus('Logged in using ChatGPT', '', 0);
    expect(status).toMatchObject({ authenticated: true, authMode: 'chatgpt' });
  });

  it('recognizes an API-key session', () => {
    expect(parseAuthStatus('Logged in using an API key', '', 0)).toMatchObject({
      authenticated: true,
      authMode: 'api',
    });
  });

  it('treats an explicit "not logged in" as unauthenticated', () => {
    expect(parseAuthStatus('Not logged in', '', 0).authenticated).toBe(false);
  });

  it('is not fooled by a prompt telling the user to log in', () => {
    expect(parseAuthStatus('You are not authenticated. Please run `codex login`.', '', 0).authenticated).toBe(false);
  });

  it('treats a non-zero exit as unauthenticated regardless of wording', () => {
    expect(parseAuthStatus('Logged in using ChatGPT', '', 1).authenticated).toBe(false);
  });

  it('defaults to unauthenticated on output it cannot interpret', () => {
    expect(parseAuthStatus('some unrelated output', '', 0).authenticated).toBe(false);
  });

  it('reports unknown mode rather than guessing', () => {
    expect(parseAuthStatus('Authenticated.', '', 0)).toMatchObject({ authenticated: true, authMode: 'unknown' });
  });
});

describe('AuthManager', () => {
  const version = processResult({ stdout: 'codex-cli 0.138.0' });

  it('reports installation from `--version`', async () => {
    const manager = new AuthManager({ codexBinary: 'codex', run: async () => version });
    expect(await manager.checkInstallation()).toMatchObject({ installed: true, version: 'codex-cli 0.138.0' });
  });

  it('reports a missing binary instead of throwing', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      run: async () => processResult({ spawnFailed: true, spawnError: 'ENOENT', code: null }),
    });
    const installation = await manager.checkInstallation();
    expect(installation.installed).toBe(false);
    expect(installation.error).toMatch(/ENOENT/);
  });

  it('raises CODEX_NOT_INSTALLED from requireInstallation', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      run: async () => processResult({ spawnFailed: true, spawnError: 'ENOENT', code: null }),
    });
    await expect(manager.requireInstallation()).rejects.toMatchObject({ code: 'CODEX_NOT_INSTALLED' });
  });

  it('raises CODEX_AUTH_REQUIRED when Codex is not logged in', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      run: async (args) => (args[0] === '--version' ? version : processResult({ stdout: 'Not logged in' })),
    });
    await expect(manager.requireAuthenticated()).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

  it('accepts a session that matches the configured mode', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      expectedMode: 'api',
      run: async (args) => (args[0] === '--version' ? version : processResult({ stdout: 'Logged in using an API key' })),
    });
    await expect(manager.requireAuthenticated()).resolves.toMatchObject({ authMode: 'api' });
  });

  it('refuses a session in a different mode than configured', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      expectedMode: 'api',
      run: async (args) => (args[0] === '--version' ? version : processResult({ stdout: 'Logged in using ChatGPT' })),
    });
    await expect(manager.requireAuthenticated()).rejects.toThrow(CodexMcpError);
    await expect(manager.requireAuthenticated()).rejects.toThrow(/AUTH_MODE is "api"/);
  });

  it('does not block when the CLI declines to report a mode', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      expectedMode: 'api',
      run: async (args) => (args[0] === '--version' ? version : processResult({ stdout: 'Authenticated.' })),
    });
    await expect(manager.requireAuthenticated()).resolves.toMatchObject({ authenticated: true });
  });

  it('caches status so a review does not re-shell for every check', async () => {
    let statusCalls = 0;
    const manager = new AuthManager({
      codexBinary: 'codex',
      run: async (args) => {
        if (args[0] === '--version') return version;
        statusCalls += 1;
        return processResult({ stdout: 'Logged in using ChatGPT' });
      },
    });
    await manager.getStatus();
    await manager.getStatus();
    expect(statusCalls).toBe(1);

    await manager.getStatus({ force: true });
    expect(statusCalls).toBe(2);
  });

  it('never exposes raw credentials through publicStatus', async () => {
    const manager = new AuthManager({
      codexBinary: 'codex',
      expectedMode: 'chatgpt',
      run: async (args) =>
        args[0] === '--version'
          ? version
          : processResult({ stdout: 'Logged in using ChatGPT with token sk-abcdefghijklmnopqrst' }),
    });
    const status = await manager.publicStatus();
    expect(JSON.stringify(status)).not.toContain('sk-abcdefghijklmnopqrst');
    expect(status).toMatchObject({ authenticated: true, authMode: 'chatgpt', modeMatchesConfiguration: true });
  });
});

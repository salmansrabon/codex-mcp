import { describe, expect, it } from 'vitest';

import { CodexRunner } from '../../src/codex/codex-runner.js';
import { loadConfig, type Config, type ConnectorConfig } from '../../src/config/config.js';
import { CodexMcpError } from '../../src/errors/codex-mcp-error.js';
import { AutoConsentGate, type ConsentGate } from '../../src/policy/consent.js';
import { handleCodexAsk, type AskDeps } from '../../src/tools/codex-ask.js';
import { Logger } from '../../src/util/logger.js';

/**
 * `codex_ask` answers in prose rather than a review delta, which makes it the
 * one surface where a question could become a path to something it should not
 * reach. Two boundaries are asserted throughout:
 *
 *   - the caller's repository is never in scope, connectors or not;
 *   - a connector is attached only when consent was actually granted, on the
 *     same terms as a review.
 */

const logger = new Logger('error');

function connector(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    name: 'jira',
    kind: 'jira',
    enabled: true,
    approval: 'once',
    transport: 'stdio',
    command: 'node',
    args: ['/tmp/jira-mcp/index.js'],
    env: {},
    headers: {},
    allowTools: [],
    denyTools: [],
    startupTimeoutMs: 30_000,
    callTimeoutMs: 60_000,
    maxRows: 500,
    timeoutMs: 10_000,
    ...overrides,
  };
}

/** Capture the argv Codex would have been launched with, without launching it. */
function harness(options: { connectors?: ConnectorConfig[]; consent?: ConsentGate; answer?: string } = {}) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const base = loadConfig({ cwd: process.cwd() });
  const config: Config = {
    ...base,
    connectors: Object.fromEntries((options.connectors ?? []).map((c) => [c.name, c])),
  };

  const runner = new CodexRunner({
    config,
    logger,
    spawn: async (args, input) => {
      calls.push({ args, cwd: input.cwd });
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({ type: 'agent_message', message: options.answer ?? 'An answer.' }),
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 1,
        spawnFailed: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });

  const deps: AskDeps = {
    runner,
    config,
    logger,
    auth: { requireAuthenticated: async () => ({ authenticated: true }) },
    consent: options.consent ?? new AutoConsentGate(false, 'No interactive client.'),
  };
  return { deps, calls };
}

const brokerArgs = (args: readonly string[]) => args.filter((arg) => arg.includes('mcp_servers.'));

describe('codex_ask', () => {
  it('answers a question with the model text', async () => {
    const { deps } = harness({ answer: 'Quantum mechanics describes matter at small scales.' });

    const result = await handleCodexAsk(deps, { question: 'What is quantum mechanics?' });

    expect(result.answer).toContain('Quantum mechanics');
  });

  it('never constrains the answer with an output schema', async () => {
    // The review path pins Codex to a review-delta schema. Prose is the point
    // here, so this argument must stay absent.
    const { deps, calls } = harness();

    await handleCodexAsk(deps, { question: 'What is quantum mechanics?' });

    expect(calls[0]!.args).not.toContain('--output-schema');
  });

  it('launches no broker when no connector is configured', async () => {
    const { deps, calls } = harness();

    await handleCodexAsk(deps, { question: 'Summarise TASK-42.' });

    expect(brokerArgs(calls[0]!.args)).toEqual([]);
  });

  it('attaches the connector when consent is granted', async () => {
    const { deps, calls } = harness({
      connectors: [connector()],
      consent: new AutoConsentGate(true, 'Approved.'),
    });

    const result = await handleCodexAsk(deps, { question: 'Summarise TASK-42.' });

    expect(brokerArgs(calls[0]!.args).length).toBeGreaterThan(0);
    expect(result.connectorsUsed).toEqual(['jira']);
  });

  it('withholds the connector when consent is denied, and says so', async () => {
    // A denied connector is a recorded limitation, never a hard failure -- the
    // same contract reviews follow.
    const { deps, calls } = harness({
      connectors: [connector()],
      consent: new AutoConsentGate(false, 'No interactive client.'),
    });

    const result = await handleCodexAsk(deps, { question: 'Summarise TASK-42.' });

    expect(brokerArgs(calls[0]!.args)).toEqual([]);
    expect(result.connectorsUsed).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/jira/i);
  });

  it('needs no prompt for a connector marked trusted', async () => {
    const { deps, calls } = harness({
      connectors: [connector({ approval: 'trusted' })],
      consent: new AutoConsentGate(false, 'No interactive client.'),
    });

    const result = await handleCodexAsk(deps, { question: 'Summarise TASK-42.' });

    expect(brokerArgs(calls[0]!.args).length).toBeGreaterThan(0);
    expect(result.connectorsUsed).toEqual(['jira']);
  });

  it('skips a connector that is configured but disabled', async () => {
    const { deps, calls } = harness({
      connectors: [connector({ enabled: false })],
      consent: new AutoConsentGate(true, 'Approved.'),
    });

    await handleCodexAsk(deps, { question: 'Summarise TASK-42.' });

    expect(brokerArgs(calls[0]!.args)).toEqual([]);
  });

  it('keeps the caller’s repository out of scope even with a connector attached', async () => {
    // Connectors widen what evidence it can reach; they must not widen what
    // filesystem it can read. `-C` stays a scratch directory.
    const { deps, calls } = harness({
      connectors: [connector()],
      consent: new AutoConsentGate(true, 'Approved.'),
    });

    await handleCodexAsk(deps, { question: 'What is in this repo?' });

    const dirIndex = calls[0]!.args.indexOf('-C');
    expect(calls[0]!.args[dirIndex + 1]).not.toBe(process.cwd());
    expect(calls[0]!.cwd).not.toBe(process.cwd());
  });

  it('keeps the sandbox read-only', async () => {
    const { deps, calls } = harness();

    await handleCodexAsk(deps, { question: 'What is quantum mechanics?' });

    const sandboxIndex = calls[0]!.args.indexOf('--sandbox');
    expect(calls[0]!.args[sandboxIndex + 1]).toBe('read-only');
  });

  it('fails before spawning when Codex is not authenticated', async () => {
    const { deps, calls } = harness();
    deps.auth = {
      requireAuthenticated: async () => {
        throw new CodexMcpError('CODEX_AUTH_REQUIRED', 'Codex is not authenticated.');
      },
    };

    await expect(handleCodexAsk(deps, { question: 'What is quantum mechanics?' })).rejects.toThrow(
      /not authenticated/,
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty question rather than spending a model call', async () => {
    const { deps, calls } = harness();

    await expect(handleCodexAsk(deps, { question: '   ' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

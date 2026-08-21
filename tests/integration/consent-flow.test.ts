import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { runProcess } from '../../src/codex/process-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { AutoConsentGate, ElicitationConsentGate, type ConsentGate } from '../../src/policy/consent.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { CANDIDATE_TEST_CASES, createFixtureProject, FAKE_CODEX, FAKE_MCP_SERVER } from '../helpers/fixture-project.js';

/**
 * A declined connector must be skipped without starting its process, and must
 * degrade the review to a recorded limitation rather than failing it.
 */

const silentLogger = new Logger('error', {}, { write: () => {} });

let fixture: { root: string; configDir: string };
let scratch: string;
let callLog: string;
let responsePath: string;
let config: Config;

const VALID_RESPONSE = {
  status: 'PASS',
  accepted: ['TC-1', 'TC-2', 'TC-3'],
  modify: [],
  remove: [],
  missing: [],
  disagreements: [],
  limitations: [],
};

function orchestrator(consent: ConsentGate): ReviewOrchestrator {
  const runner = new CodexRunner({
    config,
    logger: silentLogger,
    spawn: async (args, input) =>
      runProcess({
        command: process.execPath,
        args: [FAKE_CODEX, ...args],
        cwd: input.cwd,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        env: { ...process.env, FAKE_CODEX_RESPONSE: responsePath },
      }),
  });
  return new ReviewOrchestrator({
    config,
    logger: silentLogger,
    authManager: new AuthManager({ codexBinary: FAKE_CODEX }),
    runner,
    consent,
  });
}

const request = () => ({
  reviewType: 'test-design' as const,
  project: { root: fixture.root },
  candidate: { testCases: CANDIDATE_TEST_CASES },
});

/** Did the downstream MCP server actually get started and called? */
function downstreamWasUsed(): boolean {
  return existsSync(callLog);
}

beforeEach(() => {
  fixture = createFixtureProject();
  scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-consent-'));
  callLog = join(scratch, 'calls.jsonl');
  responsePath = join(scratch, 'response.json');
  writeFileSync(responsePath, JSON.stringify(VALID_RESPONSE));

  writeFileSync(
    join(fixture.configDir, 'codex-mcp.yaml'),
    [
      'connectors:',
      '  jira-mcp:',
      '    enabled: true',
      '    kind: jira',
      '    approval: always',
      '    transport: stdio',
      `    command: ${process.execPath}`,
      '    args:',
      `      - ${FAKE_MCP_SERVER}`,
      '    env:',
      `      FAKE_MCP_CALL_LOG: ${callLog}`,
    ].join('\n'),
  );
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('connector consent during a review', () => {
  it('uses an approved connector', async () => {
    const result = await orchestrator(new AutoConsentGate(true)).qualify(request());
    expect(result.meta.evidence.connectors).toContain('jira-mcp');
  });

  it('skips a declined connector and records why', async () => {
    const result = await orchestrator(new AutoConsentGate(false)).qualify(request());

    expect(result.status).toBe('PASS');
    expect(result.meta.evidence.connectors).toEqual([]);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/jira-mcp/);
  });

  it('never starts the downstream process when consent is refused', async () => {
    await orchestrator(new AutoConsentGate(false)).qualify(request());
    expect(downstreamWasUsed()).toBe(false);
  });

  it('asks the user, and the prompt names the connector', async () => {
    const seen: string[] = [];
    const gate = new ElicitationConsentGate(async (message) => {
      seen.push(message);
      return 'accept';
    }, silentLogger);

    await orchestrator(gate).qualify(request());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/jira-mcp/);
    expect(seen[0]).toMatch(/read issues/);
  });

  it('defaults to refusing when no consent gate is supplied', async () => {
    // A non-interactive embedder cannot obtain consent, so external access must
    // not happen by default.
    const runner = new CodexRunner({
      config,
      logger: silentLogger,
      spawn: async (args, input) =>
        runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          cwd: input.cwd,
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          env: { ...process.env, FAKE_CODEX_RESPONSE: responsePath },
        }),
    });
    const bare = new ReviewOrchestrator({
      config,
      logger: silentLogger,
      authManager: new AuthManager({ codexBinary: FAKE_CODEX }),
      runner,
    });

    const result = await bare.qualify(request());
    expect(result.meta.evidence.connectors).toEqual([]);
    expect(downstreamWasUsed()).toBe(false);
  });

  it('does not ask at all for a trusted connector', async () => {
    writeFileSync(
      join(fixture.configDir, 'codex-mcp.yaml'),
      readFileSync(join(fixture.configDir, 'codex-mcp.yaml'), 'utf8').replace('approval: always', 'approval: trusted'),
    );
    config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };

    const elicit = vi.fn(async () => 'decline' as const);
    const result = await orchestrator(new ElicitationConsentGate(elicit, silentLogger)).qualify(request());

    expect(elicit).not.toHaveBeenCalled();
    expect(result.meta.evidence.connectors).toContain('jira-mcp');
  });
});

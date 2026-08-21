import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { runProcess } from '../../src/codex/process-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { CANDIDATE_TEST_CASES, createFixtureProject, FAKE_CODEX } from '../helpers/fixture-project.js';

let fixture: { root: string; configDir: string };
let logPath: string;
let responsePath: string;
let config: Config;

const silentLogger = new Logger('error', {}, { write: () => {} });

const VALID_RESPONSE = {
  status: 'PASS',
  accepted: ['TC-1', 'TC-2', 'TC-3'],
  modify: [],
  remove: [],
  missing: [],
  disagreements: [],
  limitations: [],
};

function orchestratorWith(fakeEnv: NodeJS.ProcessEnv, overrides: Partial<Config> = {}): ReviewOrchestrator {
  const merged: Config = { ...config, ...overrides };
  const runner = new CodexRunner({
    config: merged,
    logger: silentLogger,
    spawn: async (args, input) =>
      runProcess({
        command: process.execPath,
        args: [FAKE_CODEX, ...args],
        cwd: input.cwd,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_RESPONSE: responsePath, ...fakeEnv },
      }),
  });
  return new ReviewOrchestrator({
    config: merged,
    logger: silentLogger,
    authManager: new AuthManager({ codexBinary: merged.codexBinary, expectedMode: merged.authMode }),
    runner,
  });
}

const request = {
  reviewType: 'test-design' as const,
  project: { root: '' },
  candidate: { testCases: CANDIDATE_TEST_CASES },
};

function invocationCount(): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
}

beforeEach(() => {
  fixture = createFixtureProject();
  const scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-fail-'));
  logPath = join(scratch, 'invocations.jsonl');
  responsePath = join(scratch, 'response.json');
  writeFileSync(responsePath, JSON.stringify(VALID_RESPONSE));
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
  request.project.root = fixture.root;
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
});

describe('malformed reviewer output', () => {
  it('retries exactly once and accepts a corrected response', async () => {
    const result = await orchestratorWith({ FAKE_CODEX_MODE: 'malformed-once' }).qualify(request);
    expect(result.status).toBe('PASS');
    expect(result.meta.outputRepairAttempts).toBe(1);
    expect(invocationCount()).toBe(2);
  });

  it('tells the reviewer what was wrong and forbids re-analysis in the retry', async () => {
    await orchestratorWith({ FAKE_CODEX_MODE: 'malformed-once' }).qualify(request);
    const retry = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[1];
    expect(retry.prompt).toContain('Your previous response was not valid');
    expect(retry.prompt.replace(/\s+/g, ' ')).toContain('Do not redo the analysis');
    expect(retry.prompt).toContain('formatting correction only');
  });

  it('fails with CODEX_OUTPUT_INVALID rather than fabricating a review', async () => {
    await expect(orchestratorWith({ FAKE_CODEX_MODE: 'malformed' }).qualify(request)).rejects.toMatchObject({
      code: 'CODEX_OUTPUT_INVALID',
    });
    expect(invocationCount()).toBe(2);
  });

  it('does not retry more than once', async () => {
    await orchestratorWith({ FAKE_CODEX_MODE: 'malformed' })
      .qualify(request)
      .catch(() => undefined);
    expect(invocationCount()).toBe(2);
  });
});

describe('Codex process failures', () => {
  it('reports a rejected model as CODEX_MODEL_NOT_AVAILABLE and does not substitute one', async () => {
    await expect(
      orchestratorWith({ FAKE_CODEX_MODE: 'model-error' }, { model: 'made-up-model' }).qualify(request),
    ).rejects.toMatchObject({ code: 'CODEX_MODEL_NOT_AVAILABLE' });
  });

  it('refuses to review with no pinned model when requireModel is set', async () => {
    await expect(
      orchestratorWith({}, { requireModel: true, model: undefined }).qualify(request),
    ).rejects.toMatchObject({ code: 'CODEX_MODEL_NOT_CONFIGURED' });
    expect(invocationCount()).toBe(0);
  });

  it('reports a CLI too old for the model as CODEX_MODEL_NOT_AVAILABLE, with the upgrade remedy', async () => {
    await expect(
      orchestratorWith({ FAKE_CODEX_MODE: 'model-too-old' }, { model: 'gpt-5.6-sol' }).qualify(request),
    ).rejects.toMatchObject({ code: 'CODEX_MODEL_NOT_AVAILABLE' });

    await orchestratorWith({ FAKE_CODEX_MODE: 'model-too-old' }, { model: 'gpt-5.6-sol' })
      .qualify(request)
      .catch((err: { message: string }) => {
        expect(err.message).toMatch(/codex update/);
      });
  });

  it('reports a crashed Codex as CODEX_EXECUTION_FAILED', async () => {
    await expect(orchestratorWith({ FAKE_CODEX_MODE: 'crash' }).qualify(request)).rejects.toMatchObject({
      code: 'CODEX_EXECUTION_FAILED',
    });
  });

  it('terminates a hung Codex and reports REVIEW_TIMEOUT', async () => {
    await expect(
      orchestratorWith({ FAKE_CODEX_MODE: 'hang' }, { reviewTimeoutMs: 1500 }).qualify(request),
    ).rejects.toMatchObject({ code: 'REVIEW_TIMEOUT' });
  }, 20_000);

  it('reports a missing Codex binary as CODEX_NOT_INSTALLED', async () => {
    const merged: Config = { ...config, codexBinary: join(fixture.configDir, 'no-such-codex') };
    const orchestrator = new ReviewOrchestrator({
      config: merged,
      logger: silentLogger,
      authManager: new AuthManager({ codexBinary: merged.codexBinary }),
    });
    await expect(orchestrator.qualify(request)).rejects.toMatchObject({ code: 'CODEX_NOT_INSTALLED' });
  });
});

describe('authentication gating', () => {
  it('refuses to review when Codex is not authenticated, without opening a browser', async () => {
    const merged: Config = { ...config };
    const authManager = new AuthManager({
      codexBinary: FAKE_CODEX,
      run: async (args, timeoutMs) =>
        runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          timeoutMs,
          env: { ...process.env, FAKE_CODEX_AUTH: 'none' },
        }),
    });
    const orchestrator = new ReviewOrchestrator({ config: merged, logger: silentLogger, authManager });

    await expect(orchestrator.qualify(request)).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
    expect(invocationCount()).toBe(0);
  });

  it('refuses when the active auth mode is not the configured one', async () => {
    const merged: Config = { ...config, authMode: 'api' };
    const authManager = new AuthManager({
      codexBinary: FAKE_CODEX,
      expectedMode: 'api',
      run: async (args, timeoutMs) =>
        runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          timeoutMs,
          env: { ...process.env, FAKE_CODEX_AUTH: 'chatgpt' },
        }),
    });
    const orchestrator = new ReviewOrchestrator({ config: merged, logger: silentLogger, authManager });
    await expect(orchestrator.qualify(request)).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

  it('accepts an API-key session when that is what is configured', async () => {
    const merged: Config = { ...config, authMode: 'api' };
    const runner = new CodexRunner({
      config: merged,
      logger: silentLogger,
      spawn: async (args, input) =>
        runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          cwd: input.cwd,
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_RESPONSE: responsePath },
        }),
    });
    const authManager = new AuthManager({
      codexBinary: FAKE_CODEX,
      expectedMode: 'api',
      run: async (args, timeoutMs) =>
        runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          timeoutMs,
          env: { ...process.env, FAKE_CODEX_AUTH: 'api' },
        }),
    });
    const orchestrator = new ReviewOrchestrator({ config: merged, logger: silentLogger, authManager, runner });
    await expect(orchestrator.qualify(request)).resolves.toMatchObject({ status: 'PASS' });
  });
});

describe('request validation and loop protection', () => {
  it('rejects an invalid project root before spawning Codex', async () => {
    await expect(
      orchestratorWith({}).qualify({ ...request, project: { root: join(fixture.configDir, 'nope') } }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
    expect(invocationCount()).toBe(0);
  });

  it('rejects a request whose candidate does not match the review type', async () => {
    await expect(
      orchestratorWith({}).qualify({ ...request, reviewType: 'bugs', candidate: { testCases: CANDIDATE_TEST_CASES } }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_REQUEST' });
  });

  it('rejects a pass beyond MAX_REVIEW_PASSES so the loop cannot run forever', async () => {
    await expect(
      orchestratorWith({}, { maxPasses: 2 }).qualify({ ...request, options: { pass: 3 } }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_REQUEST' });
    expect(invocationCount()).toBe(0);
  });

  it('signals when the pass budget is exhausted', async () => {
    const first = await orchestratorWith({}, { maxPasses: 2 }).qualify({ ...request, options: { pass: 1 } });
    expect(first.meta.furtherPassesAllowed).toBe(true);

    const second = await orchestratorWith({}, { maxPasses: 2 }).qualify({ ...request, options: { pass: 2 } });
    expect(second.meta.furtherPassesAllowed).toBe(false);
  });

  it('rejects a candidate set above the configured cap', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `TC-${i}`, title: 't' }));
    await expect(
      orchestratorWith({}, { maxCandidateItems: 5 }).qualify({ ...request, candidate: { testCases: many } }),
    ).rejects.toThrow(/above the configured limit/);
  });

  it('tells the reviewer which pass it is on', async () => {
    await orchestratorWith({}, { maxPasses: 2 }).qualify({ ...request, options: { pass: 2 } });
    const prompt = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0].prompt;
    expect(prompt).toContain('This is pass 2 of at most 2');
  });
});

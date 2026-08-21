import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Concurrency and cancellation around the review slot pool.
 *
 * These exist because a real qualification run against this repository flagged
 * both as untested: the suite exercised individual reviews and failure paths,
 * but never that an excess request actually waits for a slot, nor that
 * cancelling a queued request releases its place cleanly. A leaked slot would
 * stall every later review, and the symptom — reviews that hang — looks
 * nothing like its cause.
 */

const silentLogger = new Logger('error', {}, { write: () => {} });

let fixture: { root: string; configDir: string };
let scratch: string;
let responsePath: string;
let baseConfig: Config;

const VALID_RESPONSE = {
  status: 'PASS',
  accepted: ['TC-1', 'TC-2', 'TC-3'],
  modify: [],
  remove: [],
  missing: [],
  disagreements: [],
  limitations: [],
};

/** Records when each Codex invocation starts and finishes. */
interface SpawnTrace {
  startedAt: number[];
  finishedAt: number[];
}

function makeOrchestrator(overrides: Partial<Config>, trace: SpawnTrace, delayMs: number): ReviewOrchestrator {
  const config: Config = { ...baseConfig, ...overrides };
  const runner = new CodexRunner({
    config,
    logger: silentLogger,
    spawn: async (args, input) => {
      trace.startedAt.push(Date.now());
      const result = await runProcess({
        command: process.execPath,
        args: [FAKE_CODEX, ...args],
        cwd: input.cwd,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        env: {
          ...process.env,
          FAKE_CODEX_RESPONSE: responsePath,
          FAKE_CODEX_DELAY_MS: String(delayMs),
        },
      });
      trace.finishedAt.push(Date.now());
      return result;
    },
  });

  return new ReviewOrchestrator({
    config,
    logger: silentLogger,
    authManager: new AuthManager({ codexBinary: FAKE_CODEX }),
    runner,
  });
}

function request() {
  return {
    reviewType: 'test-design' as const,
    project: { root: fixture.root },
    candidate: { testCases: CANDIDATE_TEST_CASES },
  };
}

beforeEach(() => {
  fixture = createFixtureProject();
  scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-conc-'));
  responsePath = join(scratch, 'response.json');
  writeFileSync(responsePath, JSON.stringify(VALID_RESPONSE));
  baseConfig = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('review slot pool', () => {
  it('holds an excess request until a slot is released', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 1 }, trace, 700);

    const [first, second] = await Promise.all([orchestrator.qualify(request()), orchestrator.qualify(request())]);

    expect(first.status).toBe('PASS');
    expect(second.status).toBe('PASS');
    expect(trace.startedAt).toHaveLength(2);

    // The second Codex process must not start before the first one finished.
    const [firstFinished] = trace.finishedAt;
    const secondStarted = trace.startedAt[1] as number;
    expect(secondStarted).toBeGreaterThanOrEqual((firstFinished as number) - 50);
  }, 30_000);

  it('runs reviews in parallel when the pool allows it', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 2 }, trace, 700);

    await Promise.all([orchestrator.qualify(request()), orchestrator.qualify(request())]);

    // Both should be in flight together, so the second starts well before the
    // first finishes. Without a pool of 2 this degenerates to serial.
    const secondStarted = trace.startedAt[1] as number;
    const firstFinished = trace.finishedAt[0] as number;
    expect(secondStarted).toBeLessThan(firstFinished);
  }, 30_000);

  it('does not leak a slot when a review fails', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 1 }, trace, 0);

    // An invalid root fails before Codex is spawned; the slot must still be
    // returned, or every later review waits forever.
    await expect(
      orchestrator.qualify({ ...request(), project: { root: join(scratch, 'missing') } }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });

    await expect(orchestrator.qualify(request())).resolves.toMatchObject({ status: 'PASS' });
  }, 30_000);
});

describe('cancellation', () => {
  it('rejects a request cancelled while it is queued', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 1 }, trace, 900);

    const holder = orchestrator.qualify(request());
    const controller = new AbortController();
    const queued = orchestrator.qualify(request(), controller.signal);

    // Let the first review take the only slot, then cancel the waiter.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    await expect(queued).rejects.toMatchObject({ code: 'CODEX_EXECUTION_FAILED' });
    await expect(holder).resolves.toMatchObject({ status: 'PASS' });

    // The cancelled request must never have reached Codex.
    expect(trace.startedAt).toHaveLength(1);
  }, 30_000);

  it('releases the queued slot so a later review can still run', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 1 }, trace, 600);

    const holder = orchestrator.qualify(request());
    const controller = new AbortController();
    const cancelled = orchestrator.qualify(request(), controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await holder;

    // A stale queue entry or a wrong active count would strand this one.
    await expect(orchestrator.qualify(request())).resolves.toMatchObject({ status: 'PASS' });
  }, 30_000);

  it('rejects immediately when the signal is already aborted', async () => {
    const trace: SpawnTrace = { startedAt: [], finishedAt: [] };
    const orchestrator = makeOrchestrator({ maxConcurrentReviews: 1 }, trace, 0);

    const controller = new AbortController();
    controller.abort();

    await expect(orchestrator.qualify(request(), controller.signal)).rejects.toMatchObject({
      code: 'CODEX_EXECUTION_FAILED',
    });

    // And the pool is undisturbed afterwards.
    await expect(orchestrator.qualify(request())).resolves.toMatchObject({ status: 'PASS' });
  }, 30_000);
});

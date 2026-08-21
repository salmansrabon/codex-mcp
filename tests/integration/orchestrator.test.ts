import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { CANDIDATE_BUGS, CANDIDATE_TEST_CASES, createFixtureProject, FAKE_CODEX } from '../helpers/fixture-project.js';

let fixture: { root: string; configDir: string };
let logPath: string;
let responsePath: string;
let config: Config;

const silentLogger = new Logger('error', {}, { write: () => {} });

const TEST_REVIEW_RESPONSE = {
  status: 'CHANGES_REQUIRED',
  accepted: ['TC-1', 'TC-2'],
  modify: [],
  remove: [
    { candidateId: 'TC-3', reason: 'Duplicates TC-1 exactly.', evidence: [], supersededBy: 'TC-1' },
  ],
  missing: [
    {
      title: 'Archiving an already-archived resource is a no-op',
      priority: 'high',
      reason: 'service.ts returns early without touching archivedAt.',
      evidence: [{ source: 'code', location: 'src/resource/service.ts:9' }],
      dimension: 'idempotency',
    },
  ],
  disagreements: [],
  limitations: [],
};

const BUG_REVIEW_RESPONSE = {
  status: 'CHANGES_REQUIRED',
  findings: [
    {
      candidateId: 'BUG-1',
      verdict: 'VERIFIED',
      confidence: 'high',
      reason: 'findResource can return null and archive() dereferences it.',
      evidence: [{ source: 'code', location: 'src/resource/service.ts:8' }],
      recommendation: 'Keep the finding.',
      missingEvidence: [],
    },
    {
      candidateId: 'BUG-2',
      verdict: 'FALSE_POSITIVE',
      confidence: 'high',
      severityAssessment: null,
      reason: 'requireTenantAccess rejects cross-tenant ids before the controller runs.',
      evidence: [
        { source: 'code', location: 'src/routes/resources.ts:7' },
        { source: 'code', location: 'src/middleware/access.ts:6' },
      ],
      recommendation: 'Remove the finding.',
      missingEvidence: [],
    },
  ],
  additionalFindings: [],
  disagreements: [],
  limitations: [],
};

function makeOrchestrator(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): ReviewOrchestrator {
  const merged: Config = { ...config, ...overrides };
  const authManager = new AuthManager({
    codexBinary: merged.codexBinary,
    ...(merged.authMode ? { expectedMode: merged.authMode } : {}),
  });
  const runner = new CodexRunner({
    config: merged,
    logger: silentLogger,
    spawn: async (args, input) => {
      const { runProcess } = await import('../../src/codex/process-runner.js');
      return runProcess({
        command: process.execPath,
        args: [FAKE_CODEX, ...args],
        cwd: input.cwd,
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_RESPONSE: responsePath, ...env },
      });
    },
  });
  return new ReviewOrchestrator({ config: merged, logger: silentLogger, authManager, runner });
}

function invocations(): { argv: string[]; prompt: string; cwd: string }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  fixture = createFixtureProject();
  const scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-run-'));
  logPath = join(scratch, 'invocations.jsonl');
  responsePath = join(scratch, 'response.json');
  writeFileSync(responsePath, JSON.stringify(TEST_REVIEW_RESPONSE));
  // Point the runner at the fake CLI for auth probing as well as for review.
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
});

describe('test-design review end to end', () => {
  it('returns a structured delta the caller can act on', async () => {
    const orchestrator = makeOrchestrator();
    const result = await orchestrator.qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      task: { id: 'DEV-123', source: 'jira', description: 'Archive a resource' },
      artifacts: { blastRadiusPath: 'docs/blast-radius.md', testCharterPath: 'docs/test-charter.md' },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(result.testDesign?.accepted).toEqual(['TC-1', 'TC-2']);
    expect(result.testDesign?.remove[0]?.candidateId).toBe('TC-3');
    expect(result.testDesign?.missing[0]?.dimension).toBe('idempotency');
    expect(result.testDesign?.summary).toEqual({ accepted: 2, modify: 0, remove: 1, missing: 1 });
    expect(result.bugs).toBeUndefined();
  });

  it('reports provenance rather than the raw project path', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      artifacts: { blastRadiusPath: 'docs/blast-radius.md', testCharterPath: 'docs/test-charter.md' },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    expect(result.meta.evidence.projectRootId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(result.meta)).not.toContain(fixture.root);
    expect(result.meta.evidence).toMatchObject({ git: true, blastRadius: true, testCharter: true });
    expect(result.meta.candidateCounts).toEqual({ testCases: 3, bugs: 0 });
  });

  it('always tells the caller it owns the final artifact', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });
    expect(result.reconciliation.codexIsNotAuthoritative).toBe(true);
    expect(result.reconciliation.instruction).toMatch(/not a verdict/i);
  });

  it('runs Codex read-only, ephemeral, and rooted at the project', async () => {
    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    const [invocation] = invocations();
    expect(invocation?.argv).toContain('--sandbox');
    expect(invocation?.argv[invocation.argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(invocation?.argv).toContain('--ephemeral');
    expect(invocation?.argv[invocation.argv.indexOf('-C') + 1]).toBe(fixture.root);
  });

  it('sends the candidates in the prompt, not through a file on disk', async () => {
    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    const [invocation] = invocations();
    expect(invocation?.prompt).toContain('TC-3');
    expect(invocation?.prompt).toContain('Candidate test cases (3)');
    expect(invocation?.prompt).toContain('Do not assume the supplied candidate is correct');
    expect(invocation?.prompt).toContain('ONLY NOW compare');
  });

  it('includes optional artifacts when present', async () => {
    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      artifacts: { blastRadiusPath: 'docs/blast-radius.md', testCharterPath: 'docs/test-charter.md' },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });
    const [invocation] = invocations();
    expect(invocation?.prompt).toContain('Blast radius — DEV-123');
    expect(invocation?.prompt).toContain('Test charter — DEV-123');
  });

  it('proceeds without artifacts and says so', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });
    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(result.meta.evidence.blastRadius).toBe(false);
    expect(invocations()[0]?.prompt).toContain('blast-radius: not supplied');
  });

  it('does not fail when an artifact path points at a missing file', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      artifacts: { blastRadiusPath: 'docs/does-not-exist.md' },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });
    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(invocations()[0]?.prompt).toContain('missing or unreadable');
  });

  it('leaves the repository byte-for-byte unchanged', async () => {
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root }).toString();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root }).toString();

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root }).toString()).toBe(before);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root }).toString()).toBe(headBefore);
  });
});

describe('bug review end to end', () => {
  beforeEach(() => {
    writeFileSync(responsePath, JSON.stringify(BUG_REVIEW_RESPONSE));
  });

  it('returns per-candidate verdicts', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: { bugs: CANDIDATE_BUGS },
    });

    expect(result.bugs?.findings.map((f) => [f.candidateId, f.verdict])).toEqual([
      ['BUG-1', 'VERIFIED'],
      ['BUG-2', 'FALSE_POSITIVE'],
    ]);
    expect(result.bugs?.summary).toEqual({ verified: 1, falsePositive: 1, needsMoreEvidence: 0, other: 0 });
    expect(result.testDesign).toBeUndefined();
  });

  it('requires evidence to be carried through to the caller', async () => {
    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: { bugs: CANDIDATE_BUGS },
    });
    const falsePositive = result.bugs?.findings.find((f) => f.verdict === 'FALSE_POSITIVE');
    expect(falsePositive?.evidence.map((e) => e.location)).toContain('src/middleware/access.ts:6');
  });
});

describe('combined review', () => {
  it('runs both reviews and reports the worst status', async () => {
    const testResponse = join(fixture.configDir, 'test-response.json');
    writeFileSync(testResponse, JSON.stringify(TEST_REVIEW_RESPONSE));

    // The fake CLI serves one canned response per run, so alternate per call.
    let call = 0;
    const merged = { ...config };
    const runner = new CodexRunner({
      config: merged,
      logger: silentLogger,
      spawn: async (args, input) => {
        const { runProcess } = await import('../../src/codex/process-runner.js');
        const which = call++ === 0 ? testResponse : responsePath;
        writeFileSync(responsePath, JSON.stringify(BUG_REVIEW_RESPONSE));
        return runProcess({
          command: process.execPath,
          args: [FAKE_CODEX, ...args],
          cwd: input.cwd,
          stdin: input.prompt,
          timeoutMs: input.timeoutMs,
          env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_RESPONSE: which },
        });
      },
    });
    const orchestrator = new ReviewOrchestrator({
      config: merged,
      logger: silentLogger,
      authManager: new AuthManager({ codexBinary: merged.codexBinary }),
      runner,
    });

    const result = await orchestrator.qualify({
      reviewType: 'combined',
      project: { root: fixture.root },
      candidate: { testCases: CANDIDATE_TEST_CASES, bugs: CANDIDATE_BUGS },
    });

    expect(result.testDesign).toBeDefined();
    expect(result.bugs).toBeDefined();
    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(invocations()).toHaveLength(2);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { CANDIDATE_BUGS, createFixtureProject, FAKE_CODEX } from '../helpers/fixture-project.js';

/**
 * The evaluation scenarios, end to end.
 *
 * Each case drives a *plausible reviewer output* through the real orchestrator
 * and asserts what the caller receives. That boundary is the point: the rules
 * being tested are the ones that survive a reviewer which is confident, fluent,
 * and wrong — so they have to hold after the model has spoken, not inside its
 * prompt.
 */

let fixture: { root: string; configDir: string };
let logPath: string;
let responsePath: string;
let config: Config;

const silentLogger = new Logger('error', {}, { write: () => {} });

/** A twelve-case artifact, the shape a hard ceiling actually arrives in. */
const TWELVE_CASES = Array.from({ length: 12 }, (_, index) => ({
  id: `TC-${String(index + 1).padStart(2, '0')}`,
  title: `Archive flow scenario ${index + 1}`,
  priority: 'medium',
  expectedResult: 'The archive call succeeds and the status is archived',
}));

function makeOrchestrator(env: NodeJS.ProcessEnv = {}): ReviewOrchestrator {
  const authManager = new AuthManager({
    codexBinary: config.codexBinary,
    ...(config.authMode ? { expectedMode: config.authMode } : {}),
  });
  const runner = new CodexRunner({
    config,
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
  return new ReviewOrchestrator({ config, logger: silentLogger, authManager, runner });
}

/** Stage the reviewer's answer for this run. */
function reviewerReturns(body: unknown): void {
  writeFileSync(responsePath, JSON.stringify(body));
}

function prompts(): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).prompt as string);
}

beforeEach(() => {
  fixture = createFixtureProject();
  const scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-scenarios-'));
  logPath = join(scratch, 'invocations.jsonl');
  responsePath = join(scratch, 'response.json');
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
});

describe('Scenario A — false confirmation prevention', () => {
  it('does not return a refuted mechanism as CONFIRMED', async () => {
    // The reviewer traced a path, found the guard on the parent object, and
    // *still* labelled its own finding CONFIRMED with high impact confidence.
    // That is the evaluation's failure, reproduced exactly.
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: ['TC-02'],
      modify: [],
      remove: [],
      missing: [
        {
          title: 'Archive is reachable without an ownership check',
          priority: 'critical',
          reason: 'the controller performs no tenant comparison of its own',
          uniqueRisk: 'a cross-tenant archive would go unnoticed',
          evidence: [{ source: 'code', location: 'src/resource/controller.ts:4' }],
          objectionPriority: 'MUST_FIX',
          verificationStatus: 'CONFIRMED',
          impactConfidence: 'high',
          verifiedPath: ['src/routes/resources.ts:6', 'src/resource/controller.ts:4'],
          contradictionsChecked: [
            {
              checked: 'whether route middleware already enforces tenant ownership',
              where: 'src/middleware/access.ts',
              outcome: 'refutes',
              detail: 'requireTenantAccess rejects a foreign tenant before the controller runs',
            },
          ],
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
    });

    const entry = result.testDesign?.missing[0];
    expect(entry?.verificationStatus).toBe('HYPOTHESIS');
    expect(entry?.impactConfidence).not.toBe('high');
    // The concern survives as a lead; only its certainty is corrected.
    expect(entry?.title).toMatch(/ownership check/);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/refuted the stated mechanism/);
  });

  it('keeps the objection when the search came back empty instead', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: [],
      modify: [],
      remove: [],
      missing: [
        {
          title: 'Already-archived resource is not covered',
          priority: 'high',
          reason: 'AC2 requires a no-op, and no candidate asserts it',
          uniqueRisk: 'a second archive could overwrite archivedAt and nothing would catch it',
          evidence: [{ source: 'requirement', location: 'docs/DEV-123.md#AC2' }],
          objectionPriority: 'MUST_FIX',
          verificationStatus: 'CONFIRMED',
          impactConfidence: 'high',
          verifiedPath: ['src/resource/controller.ts:4', 'src/resource/service.ts:9'],
          contradictionsChecked: [
            { checked: 'an existing test asserting the no-op', where: 'src and docs', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
    });

    expect(result.testDesign?.missing[0]?.verificationStatus).toBe('CONFIRMED');
    expect(result.testDesign?.missing[0]?.impactConfidence).toBe('high');
    expect(result.status).toBe('CHANGES_REQUIRED');
  });
});

describe('Scenario B — genuine missing coverage still lands', () => {
  it('carries an evidenced race-condition gap through to the caller as required work', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: TWELVE_CASES.map((testCase) => testCase.id),
      modify: [],
      remove: [],
      missing: [
        {
          title: 'Concurrent archive requests can both write archivedAt',
          priority: 'high',
          reason: 'findResource and the write are not atomic, so two requests interleave',
          uniqueRisk: 'the later request overwrites the first archive timestamp, losing audit accuracy',
          dimension: 'concurrency',
          evidence: [{ source: 'code', location: 'src/resource/service.ts:9' }],
          coverageChecked: ['docs/test-charter.md', 'no test directory present'],
          objectionPriority: 'MUST_FIX',
          verificationStatus: 'CONFIRMED',
          evidenceConfidence: 'high',
          impactConfidence: 'medium',
          verifiedPath: ['src/routes/resources.ts:6', 'src/resource/controller.ts:4', 'src/resource/service.ts:9'],
          contradictionsChecked: [
            { checked: 'a transaction or lock around the status write', where: 'src/resource/service.ts', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
    });

    expect(result.status).toBe('CHANGES_REQUIRED');
    const entry = result.testDesign?.missing[0];
    expect(entry?.objectionPriority).toBe('MUST_FIX');
    expect(entry?.verificationStatus).toBe('CONFIRMED');
    // The two confidences disagree, and the result keeps both.
    expect(entry?.evidenceConfidence).toBe('high');
    expect(entry?.impactConfidence).toBe('medium');
    expect(entry?.evidence[0]?.location).toBe('src/resource/service.ts:9');
  });
});

describe('Scenario C — coverage the caller declared already exists', () => {
  it('tells the reviewer not to re-request it, and demotes an unsearched demand', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: TWELVE_CASES.map((testCase) => testCase.id),
      modify: [],
      remove: [],
      missing: [
        {
          title: 'Boundary values for the id parameter are untested',
          priority: 'medium',
          reason: 'no candidate exercises the boundary values',
          uniqueRisk: 'a malformed id could reach the service layer',
          evidence: [{ source: 'code', location: 'src/resource/controller.ts:4' }],
          coverageChecked: [],
          objectionPriority: 'MUST_FIX',
          verificationStatus: 'PROVISIONAL',
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
      knownCoverage: [
        {
          area: 'request-schema boundary validation for the id parameter',
          location: 'test/unit/validation.spec.js',
          source: 'automated-suite',
          note: 'the existing suite covers min, max, and malformed values',
        },
      ],
    });

    // The declaration reaches the reviewer, with the rule attached.
    const prompt = prompts()[0] ?? '';
    expect(prompt).toContain('Coverage the caller states already exists');
    expect(prompt).toContain('test/unit/validation.spec.js');
    expect(prompt).toMatch(/must not do is ask for it again/);

    // And a MUST_FIX that never searched it does not survive as required work.
    expect(result.testDesign?.missing[0]?.objectionPriority).toBe('SHOULD_FIX');
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/before calling the scenario untested/);
  });
});

describe('Scenario D — a hard test-case ceiling', () => {
  it('asks for a portfolio decision and reports additions that overflow without one', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: TWELVE_CASES.map((testCase) => testCase.id),
      modify: [],
      remove: [],
      missing: [
        {
          title: 'Stale response sequencing',
          priority: 'high',
          reason: 'a superseded response can be applied last',
          uniqueRisk: 'the user sees data from a request that was already replaced',
          evidence: [{ source: 'code', location: 'src/resource/service.ts:9' }],
          objectionPriority: 'MUST_FIX',
        },
        {
          title: 'Archive of a missing resource returns 404',
          priority: 'medium',
          reason: 'AC-adjacent path with no candidate',
          uniqueRisk: 'a null dereference would surface as a 500 instead of a 404',
          evidence: [{ source: 'code', location: 'src/middleware/access.ts:5' }],
          objectionPriority: 'SHOULD_FIX',
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
      constraints: { maxTestCases: 12 },
    });

    const prompt = prompts()[0] ?? '';
    expect(prompt).toContain('at most **12 test cases**');
    expect(prompt).toMatch(/portfolio, not as a list you may append to/);
    expect(prompt).toContain('`displaces`');

    expect(result.testDesign?.portfolio).toMatchObject({
      ceiling: 12,
      retained: 12,
      proposedAdditions: 2,
      withinCeiling: false,
    });
    expect(result.testDesign?.portfolio?.unresolvedOverflow).toEqual([
      'Stale response sequencing',
      'Archive of a missing resource returns 404',
    ]);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/without naming what they displace/);
  });

  it('respects the ceiling when the reviewer names what each addition displaces', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: TWELVE_CASES.filter((testCase) => testCase.id !== 'TC-08').map((testCase) => testCase.id),
      modify: [],
      remove: [
        {
          candidateId: 'TC-08',
          reason: 'a schema-level boundary already covered by unit tests',
          evidence: [{ source: 'test', location: 'test/unit/validation.spec.js' }],
          objectionPriority: 'SHOULD_FIX',
        },
      ],
      missing: [
        {
          title: 'Stale response sequencing',
          priority: 'high',
          reason: 'a superseded response can be applied last',
          uniqueRisk: 'a distinct user-visible race that no other case protects',
          evidence: [{ source: 'code', location: 'src/resource/service.ts:9' }],
          objectionPriority: 'MUST_FIX',
          displaces: [
            {
              candidateId: 'TC-08',
              action: 'REMOVE',
              reason: 'TC-13 protects a distinct user-visible race while TC-08 duplicates lower-level coverage',
            },
          ],
        },
      ],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: TWELVE_CASES },
      constraints: { maxTestCases: 12 },
    });

    expect(result.testDesign?.portfolio).toMatchObject({ retained: 11, proposedAdditions: 1, withinCeiling: true });
    expect(result.testDesign?.portfolio?.unresolvedOverflow).toEqual([]);
    expect(result.testDesign?.missing[0]?.displaces[0]).toMatchObject({ candidateId: 'TC-08', action: 'REMOVE' });
  });
});

describe('Scenario E — a test with no oracle', () => {
  it('instructs the reviewer to reject observation-only and human-deferred expectations', async () => {
    reviewerReturns({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: {
        testCases: [
          { id: 'TC-1', title: 'Archive a resource', expectedResult: 'Record what happens' },
          { id: 'TC-2', title: 'Archive twice', expectedResult: 'Ask the product owner whether this is correct' },
        ],
      },
    });

    const prompt = prompts()[0] ?? '';
    expect(prompt).toMatch(/no oracle — no expected result at all/);
    expect(prompt).toMatch(/observation-only steps/);
    expect(prompt).toMatch(/deferred assertion/);
    expect(prompt).toMatch(/no failure signal/);
  });

  it('carries a no-oracle objection through as required work', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      accepted: [],
      modify: [
        {
          candidateId: 'TC-1',
          reason: 'the expected result is "record what happens", which cannot fail',
          recommendation: 'state the archived status and archivedAt values AC1 requires',
          evidence: [{ source: 'requirement', location: 'docs/DEV-123.md#AC1' }],
          objectionPriority: 'MUST_FIX',
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['candidate TC-1 expectedResult', 'docs/DEV-123.md#AC1'],
          contradictionsChecked: [
            { checked: 'whether an assertion is stated elsewhere in the case', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      remove: [],
      missing: [],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource', expectedResult: 'Record what happens' }] },
    });

    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(result.testDesign?.modify[0]?.objectionPriority).toBe('MUST_FIX');
    expect(result.testDesign?.modify[0]?.verificationStatus).toBe('CONFIRMED');
  });
});

describe('Scenario F — behavior that depends on a repository outside the review', () => {
  it('keeps a cross-repository verdict provisional rather than confirmed', async () => {
    reviewerReturns({
      status: 'CHANGES_REQUIRED',
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'VERIFIED',
          confidence: 'high',
          reason: 'archive() dereferences a possibly-null resource',
          recommendation: 'keep the finding',
          evidence: [{ source: 'code', location: 'src/resource/service.ts:8' }],
          missingEvidence: [],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/resource/service.ts:8'],
          contradictionsChecked: [
            {
              checked: 'whether the calling service in the other repository validates the id first',
              outcome: 'unresolved',
              detail: 'that repository is not under this review root',
            },
          ],
          scopeCaveat: 'the upstream caller lives in a repository outside this review root',
        },
        {
          candidateId: 'BUG-2',
          verdict: 'FALSE_POSITIVE',
          confidence: 'high',
          severityAssessment: null,
          reason: 'requireTenantAccess rejects a foreign tenant before the controller runs',
          recommendation: 'withdraw the finding',
          evidence: [
            { source: 'code', location: 'src/routes/resources.ts:6' },
            { source: 'code', location: 'src/middleware/access.ts:6' },
          ],
          missingEvidence: [],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/routes/resources.ts:6', 'src/middleware/access.ts:6', 'src/resource/controller.ts:4'],
          contradictionsChecked: [
            { checked: 'an alternate route reaching the controller without the middleware', where: 'src/routes', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      additionalFindings: [],
      disagreements: [],
      limitations: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: { bugs: CANDIDATE_BUGS },
    });

    const [crossRepo, refuted] = result.bugs?.findings ?? [];

    // Unresolved contradiction plus a one-hop trace: not a confirmation.
    expect(crossRepo?.verificationStatus).toBe('PROVISIONAL');
    expect(crossRepo?.confidence).toBe('medium');
    expect(crossRepo?.scopeCaveat).toMatch(/outside this review root/);

    // The withdrawal, by contrast, did the work and keeps its strength.
    expect(refuted?.verdict).toBe('FALSE_POSITIVE');
    expect(refuted?.verificationStatus).toBe('CONFIRMED');
    expect(refuted?.confidence).toBe('high');
  });
});

describe('adaptive depth reaches the reviewer and the caller', () => {
  it('assesses the change and reports the budget it applied', async () => {
    reviewerReturns({ status: 'PASS', accepted: ['TC-1'], modify: [], remove: [], missing: [] });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
    });

    expect(['SMALL', 'MEDIUM', 'HIGH']).toContain(result.meta.depth);
    expect(result.meta.depthSignals.length).toBeGreaterThan(0);

    const prompt = prompts()[0] ?? '';
    expect(prompt).toContain('## Review depth budget');
    expect(prompt).toMatch(/Escalation is always allowed/);
    expect(prompt).toContain(`Assessed depth: ${result.meta.depth}`);
    // The effort actually passed to Codex is the one reported back.
    expect(prompt).not.toContain('model_reasoning_effort');
    expect(result.meta.reasoningEffort).toBeTruthy();
  });

  it('never spends a shallow budget on an unresolvable change set', async () => {
    // The fixture is not a git work tree here, so the affected surface is
    // unknown — the one case where cheap would be dangerous.
    const noGit = createFixtureProject({ git: false });
    reviewerReturns({ status: 'PASS', accepted: ['TC-1'], modify: [], remove: [], missing: [] });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: noGit.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
    });

    expect(result.meta.depth).toBe('HIGH');
    expect(result.meta.reasoningEffort).toBe(config.reasoningEffort);
    rmSync(noGit.configDir, { recursive: true, force: true });
  });
});

describe('self-audit and falsification rules are always present', () => {
  it('gives every review type the falsification chain, the three confidences, and the self-check', async () => {
    reviewerReturns({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });

    await makeOrchestrator().qualify({
      reviewType: 'combined',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }], bugs: CANDIDATE_BUGS.slice(0, 1) },
    });

    const all = prompts();
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const prompt of all) {
      expect(prompt).toContain('claim → evidence → dependency trace → contradiction search → confidence');
      expect(prompt).toMatch(/Prefer `PROVISIONAL` over a weakly supported `CONFIRMED`/);
      expect(prompt).toContain('## Self-audit before you answer');
      expect(prompt).toMatch(/A refutation is a good outcome/);
      // Stated once each, in the base layer: a rule restated per review type
      // gets diluted rather than emphasized.
      expect(prompt.match(/## Falsify your own findings before you trust them/g)?.length).toBe(1);
      expect(prompt.match(/## Self-audit before you answer/g)?.length).toBe(1);
    }
  });

  it('does not hardcode the evaluation examples into the reviewer', async () => {
    reviewerReturns({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
    });

    const prompt = prompts()[0] ?? '';
    // The rules must generalize; naming the evaluation's stack or objects would
    // teach the reviewer one project instead of one method.
    for (const leaked of ['Joi', 'joi', 'peripheral', 'cabinet', 'Mocha', 'mocha']) {
      expect(prompt).not.toContain(leaked);
    }
  });
});

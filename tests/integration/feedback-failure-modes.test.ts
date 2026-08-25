import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { toCompactResult } from '../../src/review/compact-result.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { createFixtureProject, FAKE_CODEX } from '../helpers/fixture-project.js';

/**
 * The four problems the latest run surfaced, driven end to end.
 *
 * As before, each supplies a *plausible reviewer output* — the failure mode is
 * always something fluent and reasonable-sounding — and asserts what the caller
 * receives after every gate has run.
 */

let fixture: { root: string; configDir: string };
let logPath: string;
let auditResponse: string;
let discoveryResponse: string;
let config: Config;

const silentLogger = new Logger('error', {}, { write: () => {} });

function makeOrchestrator(): ReviewOrchestrator {
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
        env: {
          ...process.env,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_RESPONSE: auditResponse,
          FAKE_CODEX_DISCOVERY_RESPONSE: discoveryResponse,
        },
      });
    },
  });
  return new ReviewOrchestrator({ config, logger: silentLogger, authManager, runner });
}

const auditReturns = (body: unknown): void => writeFileSync(auditResponse, JSON.stringify(body));
const discoveryReturns = (body: unknown): void => writeFileSync(discoveryResponse, JSON.stringify(body));

function prompts(): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).prompt as string);
}

const CLEAN_SWEEP = [
  'security-authn-authz',
  'data-corruption-or-loss',
  'critical-business-rule',
  'migration-or-deployment',
  'backward-compatibility',
  'availability-or-performance-collapse',
].map((blockerClass) => ({
  blockerClass,
  applicable: true,
  outcome: 'no-blocker-found',
  detail: 'inspected and clear',
  inspected: ['src/resource/service.ts'],
  findings: [],
}));

const emptyDiscovery = (overrides: Record<string, unknown> = {}): unknown => ({
  status: 'PASS',
  findings: [],
  blockerSweep: CLEAN_SWEEP,
  coverageMap: [],
  rulesApplied: [],
  limitations: [],
  projectMemory: [],
  ...overrides,
});

const testReview = (overrides: Record<string, unknown> = {}): unknown => ({
  status: 'CHANGES_REQUIRED',
  accepted: [],
  modify: [],
  remove: [],
  missing: [],
  disagreements: [],
  limitations: [],
  projectMemory: [],
  ...overrides,
});

beforeEach(() => {
  fixture = createFixtureProject();
  const scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-feedback-'));
  logPath = join(scratch, 'invocations.jsonl');
  auditResponse = join(scratch, 'audit.json');
  discoveryResponse = join(scratch, 'discovery.json');
  discoveryReturns(emptyDiscovery());
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
});

describe('1. an asserted behavior nothing establishes', () => {
  const prefillEntry = (overrides: Record<string, unknown> = {}): unknown => ({
    title: 'Phone number is safely prefilled',
    priority: 'high',
    reason: 'The form should prefill the phone number from the account profile.',
    evidence: [{ source: 'code', location: 'src/resource/service.ts:1' }],
    suggestedAssertion: 'Assert the phone is safely prefilled',
    uniqueRisk: 'A user retyping a number they already gave us gets it wrong.',
    coverageChecked: ['test/'],
    objectionPriority: 'MUST_FIX',
    verificationStatus: 'CONFIRMED',
    verifiedPath: ['src/routes/resources.ts:1', 'src/resource/service.ts:1'],
    contradictionsChecked: [{ checked: 'an existing prefill test', outcome: 'no-contradiction-found' }],
    ...overrides,
  });

  it('does not let a plausible prefill become a MUST_FIX test expectation', async () => {
    auditReturns(testReview({ missing: [prefillEntry({ behaviorBasis: 'none' })] }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      options: { view: 'full' },
    });

    const entry = result.testDesign?.missing[0];
    expect(entry?.objectionPriority).toBe('OPTIONAL');
    expect(entry?.verificationStatus).toBe('HYPOTHESIS');
    // Stated in the field the author reads, not only in a limitation.
    expect(entry?.reason).toMatch(/^\[UNPROVEN/);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/unsupported-assertion/);
  });

  it('demotes an assertion that names a basis but cites nothing for it', async () => {
    auditReturns(testReview({ missing: [prefillEntry({ behaviorBasis: 'acceptance-criterion', behaviorEvidence: [] })] }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.missing[0]?.objectionPriority).toBe('OPTIONAL');
    expect(result.testDesign?.missing[0]?.reason).toMatch(/cites nothing for it/);
  });

  it('keeps a grounded assertion blocking', async () => {
    auditReturns(
      testReview({
        missing: [
          prefillEntry({
            behaviorBasis: 'acceptance-criterion',
            behaviorEvidence: [{ source: 'requirement', location: 'DEV-1#AC2' }],
          }),
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      task: { id: 'DEV-1', acceptanceCriteria: ['The phone number is prefilled from the account profile.'] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.missing[0]?.objectionPriority).toBe('MUST_FIX');
  });

  it('surfaces the demoted assertion as an investigation, not as optional polish', async () => {
    auditReturns(testReview({ missing: [prefillEntry({ behaviorBasis: 'none' })] }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      options: { view: 'full' },
    });

    const compact = toCompactResult(result);
    expect(compact.investigate.some((entry) => entry.subject.includes('prefilled'))).toBe(true);
    expect(compact.mustChange).toHaveLength(0);
  });
});

describe('2. ticket prose is not settled specification', () => {
  const disagreement = (authority: Record<string, unknown> | undefined): unknown => ({
    topic: 'phone number format',
    candidatePosition: 'the test accepts a local-format number',
    reviewerPosition: 'the ticket shows +8801700000000, so the test must expect E.164',
    evidence: [{ source: 'requirement', location: 'DEV-1' }],
    material: true,
    ...(authority ? { authority } : {}),
  });

  it('does not block on a disagreement the reviewer itself called illustrative', async () => {
    auditReturns(
      testReview({
        status: 'CHANGES_REQUIRED',
        disagreements: [
          disagreement({
            sourcesAvailable: ['ticket-prose', 'implementation'],
            authoritative: 'ticket-prose',
            reason: 'the ticket is the only thing that mentions a format',
            ticketTextRole: 'illustrative',
            conflictIsReal: true,
          }),
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit a phone number' }] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(false);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/source-authority/);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/rests on ticket prose/);
  });

  it('does not block when no source of authority was worked out at all', async () => {
    auditReturns(testReview({ disagreements: [disagreement(undefined)] }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit a phone number' }] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(false);
  });

  it('drops a precedence override that names a project rule nobody supplied', async () => {
    auditReturns(
      testReview({
        disagreements: [
          disagreement({
            sourcesAvailable: ['ticket-prose', 'project-rule'],
            authoritative: 'project-rule',
            reason: 'a rule says the ticket wins',
            ticketTextRole: 'normative',
            conflictIsReal: true,
            precedenceOverriddenBy: '.claude/rules/invented.md',
          }),
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit a phone number' }] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(false);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/no such rule was retrieved/);
  });

  it('honours a precedence override that names a rule which really was retrieved', async () => {
    mkdirSync(join(fixture.root, '.claude/rules'), { recursive: true });
    writeFileSync(
      join(fixture.root, '.claude/rules/phone-format.md'),
      '# Phone format\n\nTicket examples of phone numbers are illustrative. The contract defines the format.\n',
    );

    auditReturns(
      testReview({
        disagreements: [
          disagreement({
            sourcesAvailable: ['ticket-prose', 'project-rule'],
            authoritative: 'project-rule',
            reason: 'the phone-format rule defines the contract',
            ticketTextRole: 'illustrative',
            conflictIsReal: true,
            precedenceOverriddenBy: join('.claude', 'rules', 'phone-format.md'),
          }),
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit a phone number' }] },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(true);
  });
});

describe('3. an acceptance criterion the author marked inferred', () => {
  it('tells the reviewer the label is a disclosure, not a claim', async () => {
    auditReturns(testReview({ status: 'PASS' }));

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      task: {
        id: 'DEV-1',
        acceptanceCriteria: [
          { text: 'The support call records a description.', provenance: 'explicit', source: 'DEV-1#AC1' },
          { text: 'The description is trimmed before storage.', provenance: 'inferred' },
        ],
      },
      options: { view: 'full' },
    });

    const prompt = prompts().find((entry) => entry.includes('independent test-design qualification')) ?? '';
    expect(prompt).toContain('AC2. [inferred]');
    expect(prompt).toContain('AC1. [explicit — DEV-1#AC1]');
    expect(prompt).toMatch(/The labelling is not a finding/);
  });

  it('will not let an inferred criterion ground a blocking disagreement', async () => {
    auditReturns(
      testReview({
        disagreements: [
          {
            topic: 'AC2 is not a real acceptance criterion',
            candidatePosition: 'the artifact lists AC2 as inferred',
            reviewerPosition: 'AC2 is presented as a requirement but is not in the ticket',
            evidence: [{ source: 'requirement', location: 'AC2' }],
            material: true,
            authority: {
              sourcesAvailable: ['acceptance-criterion'],
              authoritative: 'acceptance-criterion',
              reason: 'AC2 defines the behavior',
              ticketTextRole: 'normative',
              conflictIsReal: true,
            },
          },
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      task: {
        id: 'DEV-1',
        acceptanceCriteria: [
          { text: 'The support call records a description.', provenance: 'explicit' },
          { text: 'The description is trimmed before storage.', provenance: 'inferred' },
        ],
      },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(false);
    expect(JSON.stringify(result.testDesign?.limitations)).toMatch(/marked inferred by the author/);
  });
});

describe('4. an explicit acceptance criterion really is contradicted', () => {
  it('still blocks, because that is the case the machinery exists to protect', async () => {
    auditReturns(
      testReview({
        disagreements: [
          {
            topic: 'description is discarded on update',
            candidatePosition: 'the test asserts the description round-trips',
            reviewerPosition: 'the update handler drops the description, contradicting AC1',
            evidence: [
              { source: 'requirement', location: 'AC1' },
              { source: 'code', location: 'src/resource/service.ts:8' },
            ],
            material: true,
            authority: {
              sourcesAvailable: ['acceptance-criterion', 'implementation'],
              authoritative: 'acceptance-criterion',
              reason: 'AC1 states the behavior and the implementation contradicts it',
              ticketTextRole: 'normative',
              conflictIsReal: true,
            },
          },
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Update a support call' }] },
      task: {
        id: 'DEV-1',
        acceptanceCriteria: [{ text: 'An updated support call retains its description.', provenance: 'explicit' }],
      },
      options: { view: 'full' },
    });

    expect(result.testDesign?.disagreements[0]?.material).toBe(true);
    expect(result.status).toBe('CHANGES_REQUIRED');
    expect(JSON.stringify(result.testDesign?.limitations)).not.toMatch(/source-authority/);
  });
});

describe('5. the compact view', () => {
  const fullish = testReview({
    modify: [
      {
        candidateId: 'TC-1',
        reason: 'the expected result cannot fail',
        evidence: [{ source: 'code', location: 'src/resource/service.ts:8', note: 'a long explanatory note '.repeat(20) }],
        recommendation: 'assert the archived status explicitly',
        objectionPriority: 'MUST_FIX',
        verificationStatus: 'CONFIRMED',
        verifiedPath: ['src/routes/resources.ts:1', 'src/resource/service.ts:8', 'src/resource/controller.ts:4'],
        contradictionsChecked: [
          { checked: 'an existing assertion elsewhere in the suite', where: 'test/', outcome: 'no-contradiction-found', detail: 'x '.repeat(60) },
          { checked: 'a snapshot covering the same field', where: 'test/', outcome: 'no-contradiction-found', detail: 'y '.repeat(60) },
        ],
        evidenceConfidence: 'high',
        impactConfidence: 'medium',
        scopeConfidence: 'high',
        scopeCaveat: 'z '.repeat(40),
        behaviorBasis: 'implementation',
        behaviorEvidence: [{ source: 'code', location: 'src/resource/service.ts:8' }],
        assertedBehavior: 'archiving sets status to archived',
      },
    ],
  });

  it('keeps every decision needed to reconcile', async () => {
    auditReturns(fullish);

    const full = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });
    const compact = toCompactResult(full);

    expect(compact.status).toBe(full.status);
    expect(compact.reviewId).toBe(full.reviewId);
    expect(compact.mustChange[0]).toMatchObject({
      id: 'TC-1',
      problem: 'the expected result cannot fail',
      action: 'assert the archived status explicitly',
    });
    expect(compact.mustChange[0]?.evidence).toContain('code:src/resource/service.ts:8');
    expect(compact.reconciliation.codexIsNotAuthoritative).toBe(true);
    expect(compact.reconciliation.fullResult).toMatch(/view.*full/);
  });

  it('is substantially smaller than the full result', async () => {
    auditReturns(fullish);

    const full = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });
    const compact = toCompactResult(full);

    const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');

    expect(compactBytes).toBeLessThan(fullBytes * 0.6);
    // The trade is reported rather than asserted.
    expect(compact.meta.fullResultBytes).toBe(fullBytes);
  });

  it('carries decision-affecting limitations and drops the label-explaining ones', async () => {
    auditReturns(
      testReview({
        missing: [
          {
            title: 'Phone is prefilled',
            priority: 'high',
            reason: 'it should be prefilled',
            evidence: [],
            suggestedAssertion: 'assert the prefill',
            uniqueRisk: 'retyping',
            coverageChecked: [],
            objectionPriority: 'MUST_FIX',
            behaviorBasis: 'none',
            verificationStatus: 'CONFIRMED',
            verifiedPath: ['a:1'],
            contradictionsChecked: [],
          },
        ],
      }),
    );

    const full = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Submit the form' }] },
      options: { view: 'full' },
    });
    const compact = toCompactResult(full);

    const areas = compact.limitations.map((limitation) => limitation.area);
    expect(areas).toContain('unsupported-assertion');
    // The entry already reads HYPOTHESIS; restating why it was downgraded is
    // diagnostics, and diagnostics are what `view: "full"` is for.
    expect(areas).not.toContain('verification-discipline');
  });
});

describe('6 and 7. adaptive execution', () => {
  /**
   * A real git repository with a real, boring diff.
   *
   * The shared fixture has no resolvable change set, which classifies HIGH by
   * design — so asserting the low-risk path against it would assert nothing.
   */
  function lowRiskRepository(): string {
    const repo = mkdtempSync(join(tmpdir(), 'codex-mcp-lowrisk-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    };
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'labels.ts'), 'export const TITLE = "Archive";\n');
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '-qm', 'initial');
    writeFileSync(join(repo, 'src', 'labels.ts'), 'export const TITLE = "Archive resource";\n');
    return repo;
  }

  it('skips the discovery pass on a small, low-risk change', async () => {
    auditReturns(testReview({ status: 'PASS' }));
    const repo = lowRiskRepository();

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: repo },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    expect(result.meta.depth).toBe('SMALL');
    expect(result.riskDiscovery).toBeUndefined();
    expect(prompts().some((prompt) => prompt.includes('independent risk discovery'))).toBe(false);
    expect(result.meta.depthSignals.join(' ')).toMatch(/independent risk discovery skipped/);
    // One Codex process, not two.
    expect(prompts()).toHaveLength(1);

    rmSync(repo, { recursive: true, force: true });
  });

  it('runs discovery on the same small change once it touches auth code', async () => {
    auditReturns(testReview({ status: 'PASS' }));
    const repo = lowRiskRepository();
    mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
    writeFileSync(join(repo, 'src', 'auth', 'guard.ts'), 'export const guard = () => true;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: repo },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    expect(result.meta.depth).not.toBe('SMALL');
    expect(result.riskDiscovery).toBeDefined();

    rmSync(repo, { recursive: true, force: true });
  });

  it('still runs discovery on a small change when a blast radius was supplied to check', async () => {
    auditReturns(testReview({ status: 'PASS' }));
    const repo = lowRiskRepository();
    writeFileSync(join(repo, 'blast-radius.md'), '# Blast radius\n\n- billing-service\n');

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: repo },
      artifacts: { blastRadiusPath: 'blast-radius.md' },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    // Having a list of places the change reaches and not checking it is the
    // failure the coverage map exists to prevent, at any depth.
    expect(result.riskDiscovery).toBeDefined();

    rmSync(repo, { recursive: true, force: true });
  });

  it('runs the full candidate-blind pass when the change is high risk', async () => {
    auditReturns(testReview({ status: 'PASS' }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    // The fixture has no resolvable change set, which is HIGH by design:
    // unknown surface is the one case where cheap is dangerous.
    expect(result.meta.depth).toBe('HIGH');
    expect(result.riskDiscovery).toBeDefined();
    const discoveryPrompt = prompts().find((prompt) => prompt.includes('independent risk discovery')) ?? '';
    expect(discoveryPrompt).toMatch(/The release-blocker sweep — every class, explicitly/);
    expect(discoveryPrompt).not.toContain('TC-1');
  });

  it('does not let an empty discovery pass outrank a clean audit', async () => {
    auditReturns(testReview({ status: 'PASS' }));
    discoveryReturns(emptyDiscovery({ status: 'INCONCLUSIVE' }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    expect(result.riskDiscovery?.status).toBe('INCONCLUSIVE');
    // It found nothing and hit no material gap, so it has told the author
    // nothing they must act on.
    expect(result.status).toBe('PASS');
  });

  it('still lets a discovery pass that found something set the status', async () => {
    auditReturns(testReview({ status: 'PASS' }));
    discoveryReturns(
      emptyDiscovery({
        status: 'CHANGES_REQUIRED',
        findings: [
          {
            title: 'tenant filter missing on export',
            area: 'export',
            reason: 'r',
            evidence: [],
            recommendation: 'x',
            severity: 'critical',
            releaseBlocking: true,
            verificationStatus: 'CONFIRMED',
            verifiedPath: ['a:1', 'b:2'],
            contradictionsChecked: [{ checked: 'a filter downstream', outcome: 'no-contradiction-found' }],
            objectionPriority: 'MUST_FIX',
          },
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
      options: { view: 'full' },
    });

    expect(result.status).toBe('CHANGES_REQUIRED');
  });
});

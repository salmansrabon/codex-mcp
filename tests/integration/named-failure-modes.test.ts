import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { CodexRunner } from '../../src/codex/codex-runner.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import { createFixtureProject, FAKE_CODEX } from '../helpers/fixture-project.js';

/**
 * The four failure modes from the evaluation that motivated this work, each
 * driven end to end through the real orchestrator.
 *
 * Every case supplies a *plausible reviewer output* — confident, fluent, and
 * wrong in the specific way the evaluation caught — and asserts what the caller
 * actually receives. That boundary matters: none of these are prompt tests. If
 * they only held inside the prompt, a model having a bad day would defeat them.
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

function auditReturns(body: unknown): void {
  writeFileSync(auditResponse, JSON.stringify(body));
}

function discoveryReturns(body: unknown): void {
  writeFileSync(discoveryResponse, JSON.stringify(body));
}

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

function emptyDiscovery(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: 'PASS',
    findings: [],
    blockerSweep: CLEAN_SWEEP,
    coverageMap: [],
    rulesApplied: [],
    limitations: [],
    projectMemory: [],
    ...overrides,
  };
}

beforeEach(() => {
  fixture = createFixtureProject();
  const scratch = mkdtempSync(join(tmpdir(), 'codex-mcp-named-'));
  logPath = join(scratch, 'invocations.jsonl');
  auditResponse = join(scratch, 'audit.json');
  discoveryResponse = join(scratch, 'discovery.json');
  discoveryReturns(emptyDiscovery());
  config = { ...loadConfig({ cwd: fixture.configDir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(fixture.configDir, { recursive: true, force: true });
});

describe('F4 — a false refutation', () => {
  const bugs = [
    {
      id: 'BUG-1',
      title: 'Any user can archive any tenant resource',
      severity: 'critical',
      stepsToReproduce: ['POST /resources/:id/archive with another tenant id'],
      expectedBehavior: '403 forbidden',
      actualBehavior: 'The controller archives the resource',
    },
  ];

  it('does not overturn the author when the reviewer merely failed to find the defect', async () => {
    auditReturns({
      status: 'CHANGES_REQUIRED',
      findings: [
        {
          candidateId: 'BUG-1',
          // The exact shape of the failure: fluent, confident, and built
          // entirely out of not having found anything.
          verdict: 'REFUTED',
          confidence: 'high',
          reason: 'I searched the routes and middleware and found no way to reach the controller cross-tenant.',
          evidence: [
            { source: 'code', location: 'src/routes/resources.ts:1' },
            { source: 'code', location: 'src/resource/controller.ts:1' },
          ],
          recommendation: 'Withdraw this finding.',
          missingEvidence: [],
          refutedBy: [],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/routes/resources.ts:1', 'src/resource/controller.ts:1'],
          contradictionsChecked: [
            { checked: 'an alternate route to the controller', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      additionalFindings: [],
      citationAssessments: [],
      disagreements: [],
      limitations: [],
      projectMemory: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: { bugs },
    });

    const finding = result.bugs?.findings[0];
    expect(finding?.verdict).toBe('UNPROVEN');
    expect(finding?.confidence).toBe('low');
    expect(finding?.recommendation).toMatch(/did not overturn this finding/);
    // An unsettled verdict is not a pass.
    expect(result.status).toBe('INCONCLUSIVE');
    expect(JSON.stringify(result.bugs?.limitations)).toMatch(/refutation-discipline/);
  });

  it('lets a refutation that found the guard stand', async () => {
    auditReturns({
      status: 'CHANGES_REQUIRED',
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'REFUTED',
          confidence: 'high',
          reason: 'requireTenantAccess rejects a foreign tenant before the controller runs.',
          evidence: [{ source: 'code', location: 'src/middleware/access.ts:6' }],
          recommendation: 'Withdraw this finding.',
          missingEvidence: [],
          refutedBy: [{ source: 'code', location: 'src/middleware/access.ts:6' }],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['src/routes/resources.ts:7', 'src/middleware/access.ts:6'],
          contradictionsChecked: [
            { checked: 'a route that skips requireTenantAccess', outcome: 'no-contradiction-found' },
          ],
        },
      ],
      additionalFindings: [],
      citationAssessments: [],
      disagreements: [],
      limitations: [],
      projectMemory: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: { bugs },
    });

    expect(result.bugs?.findings[0]?.verdict).toBe('REFUTED');
  });
});

describe('the fabricated auth.js citation', () => {
  it('names the citation that points at nothing, without overturning the finding', async () => {
    auditReturns({
      status: 'CHANGES_REQUIRED',
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'UNPROVEN',
          confidence: 'low',
          reason: 'Could not locate the cited code.',
          evidence: [],
          recommendation: 'Investigate further.',
          missingEvidence: [],
          refutedBy: [],
          verificationStatus: 'PROVISIONAL',
          verifiedPath: [],
          contradictionsChecked: [],
        },
      ],
      additionalFindings: [],
      citationAssessments: [],
      disagreements: [],
      limitations: [],
      projectMemory: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: {
        bugs: [
          {
            id: 'BUG-1',
            title: 'Auth middleware skips the tenant check',
            evidence: [{ source: 'code', location: 'src/middleware/auth.js:42' }],
          },
        ],
      },
    });

    // Reported as a fact about the write-up...
    const citationNote = result.bugs?.limitations.find((limitation) => limitation.area === 'author-citation');
    expect(citationNote?.detail).toMatch(/src\/middleware\/auth\.js:42/);
    expect(citationNote?.detail).toMatch(/does not exist/);
    // ...and explicitly not as grounds to discard the finding.
    expect(citationNote?.impact).toMatch(/does not by itself make the finding false/);
    expect(result.meta.evidence.citations).toMatchObject({ checked: 1, broken: 1 });
    expect(result.bugs?.citationChecks?.[0]?.status).toBe('MISSING_FILE');
  });

  it('settles the citation in code, and tells the reviewer not to read it as a refutation', async () => {
    auditReturns({
      status: 'PASS',
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'UNPROVEN',
          confidence: 'low',
          reason: 'r',
          evidence: [],
          recommendation: 'x',
          missingEvidence: [],
          refutedBy: [],
        },
      ],
      additionalFindings: [],
      citationAssessments: [],
      disagreements: [],
      limitations: [],
      projectMemory: [],
    });

    await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      candidate: {
        bugs: [
          {
            id: 'BUG-1',
            title: 'Auth middleware skips the tenant check',
            evidence: [{ source: 'code', location: 'src/middleware/auth.js:42' }],
          },
        ],
      },
    });

    const auditPrompt = prompts().find((prompt) => prompt.includes('independent bug qualification')) ?? '';
    expect(auditPrompt).toContain('checked against the filesystem');
    expect(auditPrompt).toContain('src/middleware/auth.js:42');
    expect(auditPrompt).toMatch(/A broken citation is not a refutation/);
  });
});

describe('F5 — a missed release blocker', () => {
  it('runs a discovery pass that never sees the candidate set', async () => {
    auditReturns({ status: 'PASS', accepted: ['TC-1'], modify: [], remove: [], missing: [] });

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
    });

    const discoveryPrompt = prompts().find((prompt) => prompt.includes('independent risk discovery')) ?? '';
    expect(discoveryPrompt).not.toBe('');
    // The anchoring the split exists to remove.
    expect(discoveryPrompt).not.toContain('TC-1');
    expect(discoveryPrompt).not.toContain('Archive a resource');
    expect(discoveryPrompt).toMatch(/What could make this feature unreleasable/);
  });

  it('surfaces a blocker the candidate set never mentioned, and blocks on it', async () => {
    auditReturns({ status: 'PASS', accepted: ['TC-1'], modify: [], remove: [], missing: [] });
    discoveryReturns(
      emptyDiscovery({
        status: 'CHANGES_REQUIRED',
        findings: [
          {
            title: 'Tenant filter is absent on the bulk export path',
            area: 'export',
            reason: 'The export handler queries without the tenant predicate the read path applies.',
            evidence: [{ source: 'code', location: 'src/resource/service.ts:1' }],
            recommendation: 'Apply the tenant predicate before release.',
            severity: 'critical',
            blockerClass: 'security-authn-authz',
            releaseBlocking: true,
            verificationStatus: 'CONFIRMED',
            verifiedPath: ['src/routes/resources.ts:1', 'src/resource/service.ts:1'],
            contradictionsChecked: [{ checked: 'a filter applied further down', outcome: 'no-contradiction-found' }],
            severityStatus: 'CONFIRMED',
            objectionPriority: 'MUST_FIX',
          },
        ],
      }),
    );

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive button label is correct' }] },
    });

    expect(result.riskDiscovery?.findings).toHaveLength(1);
    expect(result.riskOverlap?.[0]).toMatchObject({ relation: 'NEW', releaseBlocking: true });
    // An audit that passed does not make the review a pass.
    expect(result.testDesign?.status).toBe('PASS');
    expect(result.status).toBe('CHANGES_REQUIRED');
  });

  it('records the sweep as incomplete when the reviewer skipped a class', async () => {
    auditReturns({ status: 'PASS', accepted: ['TC-1'], modify: [], remove: [], missing: [] });
    discoveryReturns(emptyDiscovery({ blockerSweep: CLEAN_SWEEP.slice(0, 3) }));

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Archive a resource' }] },
    });

    expect(JSON.stringify(result.riskDiscovery?.limitations)).toMatch(/never considered: migration-or-deployment/);
  });
});

describe('F6 — a finding the project had already ruled on', () => {
  it('retrieves the applicable rule and puts it in the prompt as source of truth', async () => {
    mkdirSync(join(fixture.root, '.claude/rules'), { recursive: true });
    writeFileSync(
      join(fixture.root, '.claude/rules/tenant-scoping.md'),
      '# Tenant scoping\n\nEvery resource query must filter by tenant id at the repository layer.\n',
    );

    auditReturns({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });

    const result = await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Resource query filters by tenant id' }] },
    });

    const prompt = prompts().find((entry) => entry.includes('independent test-design qualification')) ?? '';
    expect(prompt).toContain(join('.claude', 'rules', 'tenant-scoping.md'));
    expect(prompt).toContain('must filter by tenant id at the repository layer');
    expect(prompt).toMatch(/Treat an\s+applicable rule as source of truth/);
    expect(result.meta.evidence.projectRules?.applied).toContain(join('.claude', 'rules', 'tenant-scoping.md'));
  });

  it('names the rules it found and did not load, so retrieval is not mistaken for absence', async () => {
    mkdirSync(join(fixture.root, '.claude/rules'), { recursive: true });
    writeFileSync(join(fixture.root, '.claude/rules/billing.md'), '# Billing\n\nInvoices are immutable.\n');

    auditReturns({ status: 'PASS', accepted: [], modify: [], remove: [], missing: [] });

    await makeOrchestrator().qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      candidate: { testCases: [{ id: 'TC-1', title: 'Dark mode toggle persists' }] },
    });

    const prompt = prompts().find((entry) => entry.includes('independent test-design qualification')) ?? '';
    expect(prompt).toContain('Further rule documents found and not loaded');
    expect(prompt).toContain(join('.claude', 'rules', 'billing.md'));
  });
});

describe('cross-repository scope', () => {
  it('marks the review scope-limited when a declared repository cannot be read', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codex-mcp-outside-'));
    auditReturns({
      status: 'PASS',
      findings: [
        {
          candidateId: 'BUG-1',
          verdict: 'CONFIRMED',
          confidence: 'high',
          reason: 'r',
          evidence: [],
          recommendation: 'x',
          missingEvidence: [],
          refutedBy: [],
          verificationStatus: 'CONFIRMED',
          verifiedPath: ['a.ts:1', 'b.ts:2'],
          contradictionsChecked: [{ checked: 'a guard', outcome: 'no-contradiction-found' }],
        },
      ],
      additionalFindings: [],
      citationAssessments: [],
      disagreements: [],
      limitations: [],
      projectMemory: [],
    });

    const result = await makeOrchestrator().qualify({
      reviewType: 'bugs',
      project: { root: fixture.root, additionalRoots: [elsewhere] },
      candidate: { bugs: [{ id: 'BUG-1', title: 'a bug' }] },
    });

    expect(result.meta.evidence.scope?.complete).toBe(false);
    expect(result.meta.evidence.scope?.unreachableRoots).toContain(elsewhere);
    // Confidence is capped because part of the system was unreadable.
    expect(result.bugs?.findings[0]?.confidence).toBe('medium');
    expect(JSON.stringify(result.bugs?.limitations)).toMatch(/could not read part of the system/);

    rmSync(elsewhere, { recursive: true, force: true });
  });
});

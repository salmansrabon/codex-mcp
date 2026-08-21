import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import type { QualifyResult } from '../../src/schemas/qualify-result.js';
import { Logger } from '../../src/util/logger.js';
import { CANDIDATE_BUGS, createFixtureProject } from '../helpers/fixture-project.js';
import { createLockoutFixture, LOCKOUT_CANDIDATE_BUGS, LOCKOUT_TEST_CASES } from '../helpers/lockout-fixture.js';

/**
 * The MVP acceptance scenarios, run against the real Codex CLI.
 *
 *   CODEX_MCP_E2E=1 npm test -- tests/e2e/mvp-scenarios.test.ts
 *
 * These assert *semantic* behavior — did it find the gap, did it refute the
 * false positive, did it find the unreported defect — rather than exact prose.
 * Matching a model's wording would make the suite flaky without making the
 * server more correct, but "it produced valid JSON" proves nothing about
 * whether this product works, so each scenario names what must be true.
 */

const ENABLED = process.env['CODEX_MCP_E2E'] === '1';
const describeE2E = ENABLED ? describe : describe.skip;
const logger = new Logger('error', {}, { write: () => {} });

/** Every file and its size, so "the reviewer changed nothing" is checkable. */
function snapshot(root: string): Record<string, number> {
  const entries: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries[relative(root, full)] = statSync(full).size;
    }
  };
  walk(root);
  return entries;
}

/** Everything the reviewer said, flattened, for semantic matching. */
function textOf(result: QualifyResult): string {
  return JSON.stringify(result).toLowerCase();
}

describeE2E('MVP acceptance scenarios against the real Codex CLI', () => {
  let lockout: { root: string; configDir: string };
  let tenant: { root: string; configDir: string };
  let config: Config;

  let scenarioA: QualifyResult;
  let scenarioB: QualifyResult;
  let scenarioC: QualifyResult;

  let lockoutBefore: Record<string, number>;
  let tenantBefore: Record<string, number>;
  let lockoutGitBefore: string;
  let tenantGitBefore: string;

  beforeAll(async () => {
    lockout = createLockoutFixture();
    tenant = createFixtureProject();
    config = loadConfig({ cwd: lockout.configDir, env: process.env });

    const authManager = new AuthManager({ codexBinary: config.codexBinary, expectedMode: config.authMode });
    await authManager.requireAuthenticated();

    lockoutBefore = snapshot(lockout.root);
    tenantBefore = snapshot(tenant.root);
    lockoutGitBefore = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: lockout.root }).toString();
    tenantGitBefore = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: tenant.root }).toString();

    const orchestrator = new ReviewOrchestrator({ config, logger, authManager });

    // A — missed coverage. The candidates are plausible and incomplete.
    scenarioA = await orchestrator.qualify({
      reviewType: 'test-design',
      project: { root: lockout.root },
      task: {
        id: 'SEC-401',
        source: 'inline',
        title: 'Lock an account after repeated failed logins',
        description: 'An account becomes locked after 5 consecutive failed login attempts.',
        acceptanceCriteria: [
          'A successful login with the correct password returns the account id.',
          'A login with an incorrect password is rejected.',
          'After 5 consecutive failed attempts the account is locked and further attempts are refused.',
          'A successful login resets the consecutive-failure count.',
          'Once locked, the account stays locked even when the correct password is supplied.',
        ],
      },
      candidate: { testCases: LOCKOUT_TEST_CASES },
    });

    // B — false positive. The controller is blamed for a check that router
    // middleware performs one hop earlier.
    scenarioB = await orchestrator.qualify({
      reviewType: 'bugs',
      project: { root: tenant.root },
      task: { id: 'DEV-123', source: 'inline', title: 'Archive a resource' },
      candidate: { bugs: CANDIDATE_BUGS },
    });

    // C — missed defect. login() never clears failedAttempts on success, and
    // no candidate mentions it.
    scenarioC = await orchestrator.qualify({
      reviewType: 'bugs',
      project: { root: lockout.root },
      task: {
        id: 'SEC-401',
        source: 'inline',
        title: 'Lock an account after repeated failed logins',
        description: 'An account becomes locked after 5 consecutive failed login attempts.',
        acceptanceCriteria: [
          'A successful login resets the consecutive-failure count, so non-consecutive failures never accumulate to a lock.',
        ],
      },
      candidate: { bugs: LOCKOUT_CANDIDATE_BUGS },
    });
  }, 30 * 60_000);

  afterAll(() => {
    if (lockout) rmSync(lockout.configDir, { recursive: true, force: true });
    if (tenant) rmSync(tenant.configDir, { recursive: true, force: true });
  });

  describe('Scenario A — missed test coverage', () => {
    it('requires changes rather than accepting an incomplete set', () => {
      expect(scenarioA.status).toBe('CHANGES_REQUIRED');
    });

    it('reports the coverage the candidates omit', () => {
      const missing = scenarioA.testDesign?.missing ?? [];
      expect(missing.length).toBeGreaterThan(0);

      const text = missing.map((entry) => `${entry.title} ${entry.reason}`.toLowerCase()).join(' | ');
      // The two planted gaps. Either the 4-vs-5 boundary or the
      // correct-password-while-locked case must appear; both is better.
      const boundary = /\b(4|four|fourth|boundary|off-by-one|threshold)\b/.test(text);
      const lockedWithGoodPassword = /(lock).*(correct|valid|right)|(correct|valid|right).*(lock)/.test(text);
      expect(boundary || lockedWithGoodPassword).toBe(true);
    });

    it('grounds every requested scenario in evidence', () => {
      for (const entry of [...(scenarioA.testDesign?.missing ?? []), ...(scenarioA.testDesign?.modify ?? [])]) {
        expect(entry.evidence.length).toBeGreaterThan(0);
        expect(entry.evidence[0]?.location).toBeTruthy();
      }
    });

    it('assigns each missing scenario a priority from the schema enum', () => {
      for (const entry of scenarioA.testDesign?.missing ?? []) {
        expect(['low', 'medium', 'high', 'critical']).toContain(entry.priority);
      }
    });
  });

  describe('Scenario B — false-positive rejection', () => {
    it('returns exactly one verdict per submitted candidate', () => {
      expect(scenarioB.bugs?.findings.map((finding) => finding.candidateId).sort()).toEqual(['BUG-1', 'BUG-2']);
    });

    it('refutes the cross-tenant claim the router already guards', () => {
      const finding = scenarioB.bugs?.findings.find((entry) => entry.candidateId === 'BUG-2');
      expect(finding?.verdict).toBe('FALSE_POSITIVE');
    });

    it('cites the upstream guard rather than asserting the refutation', () => {
      const finding = scenarioB.bugs?.findings.find((entry) => entry.candidateId === 'BUG-2');
      expect(finding?.evidence.length).toBeGreaterThan(0);
      const cited = (finding?.evidence ?? []).map((item) => item.location.toLowerCase()).join(' ');
      // The guard lives in the router/middleware layer, not the controller the
      // candidate blames. Naming it is what proves the path was traced.
      expect(cited).toMatch(/middleware|route|access/);
    });
  });

  describe('Scenario C — missed-bug discovery', () => {
    it('reports a defect no candidate submitted', () => {
      expect((scenarioC.bugs?.additionalFindings ?? []).length).toBeGreaterThan(0);
    });

    it('finds the failure counter that is never reset on success', () => {
      const found = (scenarioC.bugs?.additionalFindings ?? [])
        .map((entry) => `${entry.title} ${entry.reason}`.toLowerCase())
        .join(' | ');
      expect(found).toMatch(/reset|clear|consecutive|clearfailures|failedattempts/);
    });

    it('ties the discovered defect to repository evidence, not speculation', () => {
      for (const entry of scenarioC.bugs?.additionalFindings ?? []) {
        expect(entry.evidence.length).toBeGreaterThan(0);
        expect(entry.evidence[0]?.location).toBeTruthy();
      }
    });
  });

  describe('normalized status is derived, not reported', () => {
    it('derives CHANGES_REQUIRED when a bug review refutes a candidate', () => {
      const verdicts = (scenarioB.bugs?.findings ?? []).map((finding) => finding.verdict);
      const unresolved = verdicts.some((v) => v === 'NEEDS_MORE_EVIDENCE' || v === 'INCONCLUSIVE');
      const actionable = verdicts.some((v) =>
        ['FALSE_POSITIVE', 'SEVERITY_DISAGREEMENT', 'DUPLICATE_OR_ALREADY_COVERED'].includes(v),
      );

      // The derivation rule, applied to whatever the live model actually
      // returned: an unreachable verdict outranks an actionable one.
      if (unresolved) expect(scenarioB.status).toBe('INCONCLUSIVE');
      else if (actionable) expect(scenarioB.status).toBe('CHANGES_REQUIRED');
    });

    it('derives CHANGES_REQUIRED when only additionalFindings require action', () => {
      const verdicts = (scenarioC.bugs?.findings ?? []).map((finding) => finding.verdict);
      const unresolved = verdicts.some((v) => v === 'NEEDS_MORE_EVIDENCE' || v === 'INCONCLUSIVE');
      if (!unresolved && (scenarioC.bugs?.additionalFindings ?? []).length > 0) {
        expect(scenarioC.status).toBe('CHANGES_REQUIRED');
      }
    });

    it('never reports PASS while a material disagreement stands', () => {
      for (const result of [scenarioA, scenarioB, scenarioC]) {
        const disagreements = [
          ...(result.testDesign?.disagreements ?? []),
          ...(result.bugs?.disagreements ?? []),
        ].filter((entry) => entry.material);
        if (disagreements.length > 0) expect(result.status).not.toBe('PASS');
      }
    });

    it('recomputes summary counts from the arrays', () => {
      const td = scenarioA.testDesign;
      expect(td?.summary).toEqual({
        accepted: td?.accepted.length,
        modify: td?.modify.length,
        remove: td?.remove.length,
        missing: td?.missing.length,
      });
    });
  });

  describe('safety', () => {
    it('leaves both fixture repositories byte-identical', () => {
      expect(snapshot(lockout.root)).toEqual(lockoutBefore);
      expect(snapshot(tenant.root)).toEqual(tenantBefore);
    });

    it('leaves git status unchanged in both fixtures', () => {
      expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: lockout.root }).toString()).toBe(
        lockoutGitBefore,
      );
      expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: tenant.root }).toString()).toBe(
        tenantGitBefore,
      );
    });

    it('writes no report of its own into either project', () => {
      for (const root of [lockout.root, tenant.root]) {
        const reportish = Object.keys(snapshot(root)).filter((path) =>
          /(test-cases|test-report|bug-report|findings|review)/i.test(path),
        );
        expect(reportish).toEqual([]);
      }
    });

    it('returns no raw project path and no credential', () => {
      for (const result of [scenarioA, scenarioB, scenarioC]) {
        expect(JSON.stringify(result.meta)).not.toContain(lockout.root);
        expect(JSON.stringify(result.meta)).not.toContain(tenant.root);
        expect(textOf(result)).not.toMatch(/passwordhash["']?\s*[:=]\s*["'][a-f0-9]{8}/);
      }
    });

    it('runs one pass per call, and reports the budget consistently', () => {
      for (const result of [scenarioA, scenarioB, scenarioC]) {
        // Each qualify() call is one independent review. maxPasses comes from
        // the operator's config, so assert the relationship rather than the
        // number — hardcoding the default made this fail against a config that
        // had legitimately raised it.
        expect(result.meta.pass).toBe(1);
        expect(result.meta.maxPasses).toBeGreaterThanOrEqual(1);
        expect(result.meta.furtherPassesAllowed).toBe(result.meta.pass < result.meta.maxPasses);
      }
    });
  });
});

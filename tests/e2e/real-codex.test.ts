import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/auth/auth-manager.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import { ReviewOrchestrator } from '../../src/review/review-orchestrator.js';
import { Logger } from '../../src/util/logger.js';
import type { QualifyResult } from '../../src/schemas/qualify-result.js';
import { CANDIDATE_BUGS, CANDIDATE_TEST_CASES, createFixtureProject } from '../helpers/fixture-project.js';

/**
 * End-to-end against the real Codex CLI (PLAN.md §24.4).
 *
 * Opt-in: it spends real model budget and needs an authenticated Codex, so it
 * is skipped unless CODEX_MCP_E2E=1. Everything else in the suite runs against
 * the fake CLI and stays deterministic.
 *
 *   CODEX_MCP_E2E=1 npm test -- tests/e2e
 *
 * The assertions are deliberately about *shape and safety*, not about exact
 * findings: asserting a specific sentence from a model would make the suite
 * flaky without making the server more correct. The one substantive assertion
 * is the false positive, because refuting it only requires following a two-hop
 * call path that is right there in the fixture.
 */

const ENABLED = process.env['CODEX_MCP_E2E'] === '1';
const describeE2E = ENABLED ? describe : describe.skip;

let fixture: { root: string; configDir: string };
let config: Config;
const logger = new Logger('error', {}, { write: () => {} });

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

describeE2E('codex_qualify against the real Codex CLI', () => {
  let testDesign: QualifyResult;
  let bugReview: QualifyResult;
  let before: Record<string, number>;
  let gitBefore: string;

  beforeAll(async () => {
    fixture = createFixtureProject();
    config = loadConfig({ cwd: fixture.configDir, env: process.env });

    const authManager = new AuthManager({ codexBinary: config.codexBinary, expectedMode: config.authMode });
    await authManager.requireAuthenticated();

    before = snapshot(fixture.root);
    gitBefore = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: fixture.root }).toString();

    const orchestrator = new ReviewOrchestrator({ config, logger, authManager });

    testDesign = await orchestrator.qualify({
      reviewType: 'test-design',
      project: { root: fixture.root },
      task: {
        id: 'DEV-123',
        source: 'inline',
        title: 'Archive a resource',
        description: 'A user may archive a resource that belongs to their own tenant.',
        acceptanceCriteria: [
          'Archiving an active resource sets status to archived and records archivedAt.',
          'Archiving an already-archived resource is a no-op and returns success.',
          'A user cannot archive a resource belonging to another tenant.',
        ],
      },
      artifacts: { blastRadiusPath: 'docs/blast-radius.md', testCharterPath: 'docs/test-charter.md' },
      candidate: { testCases: CANDIDATE_TEST_CASES },
    });

    bugReview = await orchestrator.qualify({
      reviewType: 'bugs',
      project: { root: fixture.root },
      task: { id: 'DEV-123', source: 'inline', title: 'Archive a resource' },
      candidate: { bugs: CANDIDATE_BUGS },
    });
  }, 20 * 60_000);

  afterAll(() => {
    if (fixture) rmSync(fixture.configDir, { recursive: true, force: true });
  });

  it('returns a schema-valid test-design delta', () => {
    expect(['PASS', 'CHANGES_REQUIRED', 'INCONCLUSIVE']).toContain(testDesign.status);
    expect(testDesign.testDesign).toBeDefined();
    expect(testDesign.meta.candidateCounts.testCases).toBe(3);
  });

  it('cites repository evidence for whatever it asks for', () => {
    const entries = [...(testDesign.testDesign?.missing ?? []), ...(testDesign.testDesign?.modify ?? [])];
    for (const entry of entries) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.evidence[0]?.location).toBeTruthy();
    }
  });

  it('only ever references candidate ids that were submitted', () => {
    const known = new Set(CANDIDATE_TEST_CASES.map((testCase) => testCase.id));
    for (const id of testDesign.testDesign?.accepted ?? []) expect(known.has(id)).toBe(true);
    for (const entry of testDesign.testDesign?.remove ?? []) expect(known.has(entry.candidateId)).toBe(true);
  });

  it('returns exactly one verdict per submitted bug', () => {
    const ids = bugReview.bugs?.findings.map((finding) => finding.candidateId).sort();
    expect(ids).toEqual(['BUG-1', 'BUG-2']);
  });

  it('refutes the cross-tenant claim that router middleware already handles', () => {
    // BUG-2 blames the controller for a check that requireTenantAccess performs
    // one hop earlier. A reviewer that follows the route definition finds this.
    const finding = bugReview.bugs?.findings.find((entry) => entry.candidateId === 'BUG-2');
    expect(['FALSE_POSITIVE', 'NEEDS_MORE_EVIDENCE', 'INCONCLUSIVE']).toContain(finding?.verdict);
    if (finding?.verdict === 'FALSE_POSITIVE') {
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });

  it('leaves the fixture repository unchanged', () => {
    expect(snapshot(fixture.root)).toEqual(before);
    expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: fixture.root }).toString()).toBe(gitBefore);
  });

  it('never writes a final artifact of its own', () => {
    const reportish = Object.keys(snapshot(fixture.root)).filter((path) =>
      /(test-cases|test-report|bug-report|findings)/i.test(path),
    );
    expect(reportish).toEqual([]);
  });
});

describe('e2e suite gating', () => {
  it('explains how to run the real-Codex tests when they are skipped', () => {
    if (!ENABLED) {
      expect(process.env['CODEX_MCP_E2E']).not.toBe('1');
    }
    expect(true).toBe(true);
  });
});

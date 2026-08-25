import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectProjectRules } from '../../src/evidence/project-rules.js';
import { collectRelatedRepositories } from '../../src/evidence/related-repositories.js';
import { resolveReviewScope } from '../../src/review/review-scope.js';
import { compareWithCandidates, normalizeRiskDiscovery } from '../../src/review/risk-discovery-reviewer.js';
import { RELEASE_BLOCKER_CLASSES } from '../../src/schemas/review-common.js';
import type { RiskDiscoveryResult } from '../../src/schemas/risk-discovery-result.js';

let workspace: string;
let root: string;

function write(base: string, relative: string, content: string): void {
  const path = join(base, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-mcp-ws-'));
  root = join(workspace, 'api');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('related-repository discovery', () => {
  it('follows a file: dependency into the repository that actually builds', async () => {
    mkdirSync(join(workspace, 'contracts'), { recursive: true });
    write(workspace, 'contracts/package.json', '{"name":"contracts"}');
    write(root, 'package.json', JSON.stringify({ dependencies: { contracts: 'file:../contracts' } }));

    const related = await collectRelatedRepositories(root, { workspaceRoot: workspace });

    expect(related.discovered.map((entry) => entry.kind)).toContain('linked-dependency');
    expect(related.discovered.some((entry) => entry.path.endsWith('contracts'))).toBe(true);
  });

  it('expands a workspace glob into its members', async () => {
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    mkdirSync(join(root, 'packages/web'), { recursive: true });
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));

    const related = await collectRelatedRepositories(root, { workspaceRoot: workspace });
    const members = related.discovered.filter((entry) => entry.kind === 'workspace-member').map((entry) => entry.path);

    expect(members).toHaveLength(2);
    expect(members.some((path) => path.endsWith('core'))).toBe(true);
  });

  it('reads submodule paths out of .gitmodules', async () => {
    mkdirSync(join(root, 'shared'), { recursive: true });
    write(root, '.gitmodules', '[submodule "shared"]\n\tpath = shared\n\turl = git@example.com:shared.git\n');

    const related = await collectRelatedRepositories(root, { workspaceRoot: workspace });

    expect(related.discovered.some((entry) => entry.kind === 'git-submodule')).toBe(true);
  });

  it('names the declaration, so a discovered relation is a citation rather than a guess', async () => {
    mkdirSync(join(workspace, 'contracts'), { recursive: true });
    write(workspace, 'contracts/package.json', '{}');
    write(root, 'package.json', JSON.stringify({ dependencies: { contracts: 'file:../contracts' } }));

    const related = await collectRelatedRepositories(root, { workspaceRoot: workspace });
    const linked = related.discovered.find((entry) => entry.kind === 'linked-dependency');

    expect(linked?.declaredBy).toBe('package.json');
  });
});

describe('scope resolution decides access separately from discovery', () => {
  it('admits a discovered repository inside the workspace', async () => {
    mkdirSync(join(workspace, 'contracts'), { recursive: true });
    const scope = await resolveReviewScope({
      projectRoot: root,
      workspaceRoot: workspace,
      related: {
        discovered: [
          { path: join(workspace, 'contracts'), kind: 'linked-dependency', declaredBy: 'package.json', detail: 'd' },
        ],
        notes: [],
      },
      allowExpansion: true,
    });

    expect(scope.additionalRoots).toHaveLength(1);
    expect(scope.complete).toBe(true);
  });

  it('refuses a path outside the workspace and reports it rather than hiding it', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codex-mcp-elsewhere-'));
    const scope = await resolveReviewScope({
      projectRoot: root,
      workspaceRoot: workspace,
      related: {
        discovered: [{ path: elsewhere, kind: 'caller-declared', declaredBy: '', detail: 'd' }],
        notes: [],
      },
      allowExpansion: true,
    });

    expect(scope.additionalRoots).toHaveLength(0);
    expect(scope.unreachableRoots).toHaveLength(1);
    // The point: a refused dependency is a named gap, not an invisible one.
    expect(scope.complete).toBe(false);
    expect(scope.gaps[0]).toMatch(/could not be read/);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('reports everything as unreachable when expansion is turned off', async () => {
    mkdirSync(join(workspace, 'contracts'), { recursive: true });
    const scope = await resolveReviewScope({
      projectRoot: root,
      workspaceRoot: workspace,
      related: {
        discovered: [
          { path: join(workspace, 'contracts'), kind: 'linked-dependency', declaredBy: 'package.json', detail: 'd' },
        ],
        notes: [],
      },
      allowExpansion: false,
    });

    expect(scope.additionalRoots).toHaveLength(0);
    expect(scope.complete).toBe(false);
  });
});

describe('project-rule retrieval', () => {
  it('finds rules inside .claude/rules, not only files at the root', async () => {
    write(root, '.claude/rules/api-contracts.md', '# API contract rules\n\nEvery endpoint must version its response.\n');
    write(root, 'CLAUDE.md', '# Project\n\nGeneral instructions.\n');

    const rules = await collectProjectRules(root, { changedFiles: ['src/api/endpoint.ts'], terms: ['endpoint response'] });

    expect(rules.discovered.map((rule) => rule.path)).toContain(join('.claude', 'rules', 'api-contracts.md'));
    expect(rules.selected.some((rule) => rule.kind === 'rule')).toBe(true);
  });

  it('always loads the project charter, whatever the change is about', async () => {
    write(root, 'CLAUDE.md', '# Project\n\nUnrelated to anything in this change.\n');

    const rules = await collectProjectRules(root, { changedFiles: ['src/x.ts'], terms: ['zzzz'] });

    expect(rules.selected.map((rule) => rule.path)).toContain('CLAUDE.md');
    expect(rules.selected[0]?.reason).toMatch(/apply to every change/);
  });

  it('does not load an unrelated rule just because it exists', async () => {
    write(root, '.claude/rules/billing.md', '# Billing\n\nInvoices are immutable once issued.\n');

    const rules = await collectProjectRules(root, {
      changedFiles: ['src/rendering/theme.ts'],
      terms: ['dark mode toggle'],
    });

    expect(rules.discovered).toHaveLength(1);
    expect(rules.selected).toHaveLength(0);
    // Discovered-but-unread is still reported, so retrieval is distinguishable
    // from absence.
    expect(rules.notes.join(' ')).toMatch(/not loaded/);
  });

  it('picks up ADRs and skills as well as rules', async () => {
    write(root, 'docs/adr/0007-tenant-isolation.md', '# ADR 7: tenant isolation\n\nEvery query filters by tenant.\n');
    write(root, '.claude/skills/tenant-check/SKILL.md', '# tenant check\n\nHow to verify tenant scoping.\n');

    const rules = await collectProjectRules(root, {
      changedFiles: ['src/repository/query.ts'],
      terms: ['tenant isolation query'],
    });

    const kinds = rules.selected.map((rule) => rule.kind);
    expect(kinds).toContain('adr');
    expect(kinds).toContain('skill');
  });
});

const discovery = (overrides: Partial<RiskDiscoveryResult> = {}): RiskDiscoveryResult =>
  ({
    status: 'PASS',
    findings: [],
    blockerSweep: [],
    coverageMap: [],
    rulesApplied: [],
    limitations: [],
    projectMemory: [],
    ...overrides,
  }) as RiskDiscoveryResult;

describe('the release-blocker sweep is answered, not assumed', () => {
  it('reports every class the reviewer never considered', () => {
    const result = normalizeRiskDiscovery(discovery(), { blastRadiusSupplied: false });
    const sweepNote = result.limitations.find((limitation) => limitation.area === 'release-blocker-sweep');

    expect(sweepNote).toBeDefined();
    for (const blockerClass of RELEASE_BLOCKER_CLASSES) {
      expect(sweepNote?.affects).toContain(blockerClass);
    }
  });

  it('reports a class that was considered and then not inspected', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        blockerSweep: RELEASE_BLOCKER_CLASSES.map((blockerClass) => ({
          blockerClass,
          applicable: true,
          outcome: blockerClass === 'backward-compatibility' ? 'not-inspected' : 'no-blocker-found',
          detail: 'd',
          inspected: [],
          findings: [],
        })),
      }),
      { blastRadiusSupplied: false },
    );

    expect(JSON.stringify(result.limitations)).toMatch(/considered but not inspected: backward-compatibility/);
  });

  it('says so when a class claims a blocker and names no finding', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        blockerSweep: RELEASE_BLOCKER_CLASSES.map((blockerClass) => ({
          blockerClass,
          applicable: true,
          outcome: blockerClass === 'security-authn-authz' ? 'blocker-found' : 'no-blocker-found',
          detail: 'd',
          inspected: ['src/auth.ts'],
          findings: [],
        })),
      }),
      { blastRadiusSupplied: false },
    );

    expect(JSON.stringify(result.limitations)).toMatch(/without naming the finding/);
  });
});

describe('the blast radius is a coverage map, not prose', () => {
  it('makes an uninspected high-risk node block the conclusion', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        coverageMap: [
          { component: 'billing-service', risk: 'high', inspected: false, evidence: [], outcome: 'not-inspected' },
        ],
      }),
      { blastRadiusSupplied: true },
    );

    const gap = result.limitations.find((limitation) => limitation.area === 'blast-radius-coverage');
    expect(gap?.material).toBe(true);
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('does not turn a volunteered coverage map into a blocked review', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        coverageMap: [
          { component: 'billing-service', risk: 'high', inspected: false, evidence: [], outcome: 'not-inspected' },
        ],
      }),
      { blastRadiusSupplied: false },
    );

    expect(result.limitations.find((limitation) => limitation.area === 'blast-radius-coverage')?.material).toBe(false);
  });

  it('treats an unreachable component as a gap rather than a clean result', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        coverageMap: [
          { component: 'partner-api', risk: 'high', inspected: true, evidence: [], outcome: 'unreachable' },
        ],
      }),
      { blastRadiusSupplied: true },
    );

    expect(JSON.stringify(result.limitations)).toMatch(/partner-api \(unreachable\)/);
  });
});

describe('a release blocker has to be traced before it can stop a release', () => {
  it('withdraws releaseBlocking from an untraced hypothesis but keeps the finding', () => {
    const result = normalizeRiskDiscovery(
      discovery({
        findings: [
          {
            title: 'migration runs before the code deploys',
            area: 'deploy',
            reason: 'r',
            evidence: [],
            recommendation: 'check the deploy order',
            severity: 'critical',
            releaseBlocking: true,
            verificationStatus: 'HYPOTHESIS',
            verifiedPath: [],
            contradictionsChecked: [],
            severityStatus: 'CONFIRMED',
            objectionPriority: 'MUST_FIX',
          },
        ],
      }),
      { blastRadiusSupplied: false },
    );

    expect(result.findings[0]?.releaseBlocking).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result.limitations)).toMatch(/releaseBlocking was withdrawn/);
  });
});

describe('comparing the two paths happens after both finished', () => {
  it('calls a discovered risk NEW when no candidate covers it', () => {
    const overlap = compareWithCandidates(
      [
        {
          title: 'tenant filter missing on the export path',
          area: 'export',
          reason: 'r',
          evidence: [],
          recommendation: 'x',
          severity: 'critical',
          releaseBlocking: true,
          verificationStatus: 'CONFIRMED',
          verifiedPath: [],
          contradictionsChecked: [],
          severityStatus: 'CONFIRMED',
          objectionPriority: 'MUST_FIX',
        },
      ],
      { testCases: [], bugs: [{ id: 'BUG-1', title: 'archive button label is wrong' }] },
    );

    expect(overlap[0]?.relation).toBe('NEW');
    expect(overlap[0]?.releaseBlocking).toBe(true);
  });

  it('links a discovered risk to the candidate that already covers it', () => {
    const overlap = compareWithCandidates(
      [
        {
          title: 'tenant filter missing on export',
          area: 'export',
          reason: 'r',
          evidence: [],
          recommendation: 'x',
          severity: 'high',
          releaseBlocking: false,
          verificationStatus: 'CONFIRMED',
          verifiedPath: [],
          contradictionsChecked: [],
          severityStatus: 'CONFIRMED',
          objectionPriority: 'SHOULD_FIX',
        },
      ],
      { testCases: [], bugs: [{ id: 'BUG-1', title: 'export leaks rows across tenant filter' }] },
    );

    expect(overlap[0]?.relation).toBe('OVERLAPS_CANDIDATE');
    expect(overlap[0]?.candidateIds).toEqual(['BUG-1']);
  });
});

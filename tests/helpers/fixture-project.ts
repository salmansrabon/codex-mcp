import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const FAKE_CODEX = join(HELPERS_DIR, 'fake-codex.mjs');
export const FAKE_MCP_SERVER = join(HELPERS_DIR, 'fake-mcp-server.mjs');

export interface FixtureProject {
  root: string;
  /** Directory holding codex-mcp.yaml / .env, i.e. the server's own cwd. */
  configDir: string;
}

/**
 * A small repository with a deliberate coverage gap and a deliberate
 * false-positive bug, mirroring the E2E fixture the plan asks for (§24.4).
 *
 * `src/resource/controller.ts` reads a caller-supplied id with no tenant check
 * of its own — the check lives in router middleware, which is exactly the thing
 * a shallow bug report misses.
 */
export function createFixtureProject(options: { git?: boolean } = {}): FixtureProject {
  const base = mkdtempSync(join(tmpdir(), 'codex-mcp-fixture-'));
  const root = join(base, 'project');

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture-app', version: '1.0.0', private: true }, null, 2),

    'docs/DEV-123.md': [
      '# DEV-123 — Archive a resource',
      '',
      'A user may archive a resource that belongs to their own tenant.',
      '',
      '## Acceptance criteria',
      '',
      '1. Archiving an active resource sets status to `archived` and records `archivedAt`.',
      '2. Archiving an already-archived resource is a no-op and returns success.',
      '3. A user cannot archive a resource belonging to another tenant.',
    ].join('\n'),

    'docs/blast-radius.md': [
      '# Blast radius — DEV-123',
      '',
      '- `src/resource/controller.ts` — new archive endpoint',
      '- `src/resource/service.ts` — status transition and persistence',
      '- `src/middleware/access.ts` — tenant ownership check applies to this route',
      '',
      'Downstream: the reporting export reads `status`, so archived rows change its output.',
    ].join('\n'),

    'docs/test-charter.md': [
      '# Test charter — DEV-123',
      '',
      'Explore archiving across: active resource, already-archived resource,',
      'missing resource, and a resource owned by another tenant.',
    ].join('\n'),

    'src/routes/resources.ts': [
      "import { requireTenantAccess } from '../middleware/access.js';",
      "import { archiveResource } from '../resource/controller.js';",
      '',
      'export function registerResourceRoutes(router) {',
      "  // Ownership is enforced here, before the controller ever runs.",
      "  router.post('/resources/:id/archive', requireTenantAccess, archiveResource);",
      '}',
    ].join('\n'),

    'src/middleware/access.ts': [
      "import { findResource } from '../resource/service.js';",
      '',
      'export async function requireTenantAccess(req, res, next) {',
      '  const resource = await findResource(req.params.id);',
      "  if (!resource) return res.status(404).json({ error: 'not found' });",
      '  if (resource.tenantId !== req.user.tenantId) {',
      "    return res.status(403).json({ error: 'forbidden' });",
      '  }',
      '  req.resource = resource;',
      '  return next();',
      '}',
    ].join('\n'),

    'src/resource/controller.ts': [
      "import { archive } from './service.js';",
      '',
      'export async function archiveResource(req, res) {',
      '  // req.params.id is caller-supplied, but ownership was already checked',
      '  // by requireTenantAccess in the route definition.',
      '  const result = await archive(req.params.id);',
      '  return res.status(200).json(result);',
      '}',
    ].join('\n'),

    'src/resource/service.ts': [
      "import { db } from '../db.js';",
      '',
      'export async function findResource(id) {',
      "  return db.resources.findOne({ id });",
      '}',
      '',
      'export async function archive(id) {',
      '  const resource = await findResource(id);',
      "  if (resource.status === 'archived') {",
      '    // Idempotent: archiving twice must not move archivedAt.',
      '    return resource;',
      '  }',
      "  resource.status = 'archived';",
      '  resource.archivedAt = new Date().toISOString();',
      '  await db.resources.save(resource);',
      '  return resource;',
      '}',
    ].join('\n'),

    'src/db.js': 'export const db = { resources: { findOne: async () => null, save: async () => {} } };',

    'tests/archive.test.js': [
      "import { archive } from '../src/resource/service.js';",
      '',
      "test('archives an active resource', async () => {",
      '  // Covers AC1 only. Nothing here covers idempotency or tenant isolation.',
      '  expect(await archive).toBeDefined();',
      '});',
    ].join('\n'),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${content}\n`, 'utf8');
  }

  if (options.git !== false) {
    const git = (...args: string[]): void => {
      execFileSync('git', args, {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'DEV-123: add archive endpoint');
  }

  return { root, configDir: base };
}

/** Candidate test cases with a redundant entry and an obvious coverage gap. */
export const CANDIDATE_TEST_CASES = [
  { id: 'TC-1', title: 'Archiving an active resource sets status to archived', priority: 'high' },
  { id: 'TC-2', title: 'Archiving an active resource records archivedAt', priority: 'medium' },
  { id: 'TC-3', title: 'Archiving an active resource sets status to archived', priority: 'low' },
];

/** One real finding and one that middleware already refutes. */
export const CANDIDATE_BUGS = [
  {
    id: 'BUG-1',
    title: 'archive() throws when the resource does not exist',
    severity: 'medium',
    stepsToReproduce: ['Call archive() with an unknown id'],
    expectedBehavior: 'A not-found error is returned',
    actualBehavior: 'resource.status throws on null',
  },
  {
    id: 'BUG-2',
    title: 'Any user can archive any tenant resource',
    severity: 'critical',
    stepsToReproduce: ['POST /resources/:id/archive with another tenant id'],
    expectedBehavior: '403 forbidden',
    actualBehavior: 'The controller archives the resource',
  },
];

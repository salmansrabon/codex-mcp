import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config, type ConnectorConfig } from '../../src/config/config.js';
import { PermissionEngine } from '../../src/policy/permission-engine.js';

let dir: string;
let projectRoot: string;
let config: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-perm-'));
  projectRoot = join(dir, 'project');
  mkdirSync(join(projectRoot, 'docs'), { recursive: true });
  writeFileSync(join(projectRoot, 'docs', 'blast-radius.md'), '# blast radius');
  config = loadConfig({ cwd: dir, env: {} });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const connector = (overrides: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  name: 'jira',
  kind: 'jira',
  enabled: true,
  transport: 'stdio',
  command: 'jira-mcp',
  args: [],
  env: {},
  headers: {},
  allowTools: [],
  denyTools: [],
  startupTimeoutMs: 1000,
  callTimeoutMs: 1000,
  maxRows: 500,
  timeoutMs: 1000,
  ...overrides,
});

describe('project root validation', () => {
  it('accepts a readable directory and returns it resolved', async () => {
    const engine = new PermissionEngine(config);
    await expect(engine.assertProjectRootReadable(projectRoot)).resolves.toBe(projectRoot);
  });

  it('rejects a path that does not exist', async () => {
    const engine = new PermissionEngine(config);
    await expect(engine.assertProjectRootReadable(join(dir, 'nope'))).rejects.toMatchObject({
      code: 'INVALID_PROJECT_ROOT',
    });
  });

  it('rejects a file masquerading as a project root', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    const engine = new PermissionEngine(config);
    await expect(engine.assertProjectRootReadable(file)).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
  });

  it('rejects an empty root', async () => {
    const engine = new PermissionEngine(config);
    await expect(engine.assertProjectRootReadable('  ')).rejects.toMatchObject({ code: 'INVALID_PROJECT_ROOT' });
  });

  it('refuses entirely when project read access is disabled', async () => {
    const engine = new PermissionEngine({
      ...config,
      permissions: { ...config.permissions, projectRead: false },
    });
    await expect(engine.assertProjectRootReadable(projectRoot)).rejects.toMatchObject({
      code: 'PROJECT_ACCESS_DENIED',
    });
  });
});

describe('artifact path containment', () => {
  it('allows a path inside the project root', () => {
    const engine = new PermissionEngine(config);
    expect(engine.assertArtifactPathAllowed(projectRoot, 'docs/blast-radius.md')).toBe(
      join(projectRoot, 'docs', 'blast-radius.md'),
    );
  });

  it('refuses traversal out of the project root', () => {
    const engine = new PermissionEngine(config);
    expect(() => engine.assertArtifactPathAllowed(projectRoot, '../../etc/passwd')).toThrow(/inside/);
  });

  it('refuses an absolute path outside the project root', () => {
    const engine = new PermissionEngine(config);
    expect(() => engine.assertArtifactPathAllowed(projectRoot, '/etc/passwd')).toThrow(/inside/);
  });

  it('is not fooled by a sibling directory sharing a name prefix', () => {
    const engine = new PermissionEngine(config);
    expect(() => engine.assertArtifactPathAllowed(join(dir, 'proj'), join(dir, 'proj-evil', 'x.md'))).toThrow(/inside/);
  });
});

describe('downstream tool decisions', () => {
  it('allows read tools from an enabled connector', () => {
    const engine = new PermissionEngine(config);
    expect(engine.evaluateDownstreamTool(connector(), 'get_issue', 'read').effect).toBe('allow');
  });

  it('refuses every tool from a disabled connector', () => {
    const engine = new PermissionEngine(config);
    expect(engine.evaluateDownstreamTool(connector({ enabled: false }), 'get_issue', 'read').effect).toBe('deny');
  });

  it('refuses mutating tools even when allowlisted', () => {
    const engine = new PermissionEngine(config);
    const decision = engine.evaluateDownstreamTool(connector({ allowTools: ['create_issue'] }), 'create_issue', 'write');
    expect(decision.effect).toBe('deny');
  });
});

describe('SQL decisions', () => {
  it('applies the connector row cap', () => {
    const engine = new PermissionEngine(config);
    const verdict = engine.evaluateSql('SELECT * FROM users', connector({ kind: 'database', maxRows: 10 }));
    expect(verdict.sanitizedSql).toBe('SELECT * FROM users LIMIT 10');
  });

  it('refuses mutation regardless of connector settings', () => {
    const engine = new PermissionEngine(config);
    expect(engine.evaluateSql('DELETE FROM users', connector({ kind: 'database' })).effect).toBe('deny');
  });
});

describe('describe()', () => {
  it('never reports write access as available', () => {
    const engine = new PermissionEngine({
      ...config,
      permissions: { ...config.permissions, projectWrite: true, gitWrite: true },
    });
    expect(engine.describe()).toMatchObject({ project: { write: false }, git: { write: false } });
  });

  it('reports whether the sandbox is the read-only one', () => {
    expect(new PermissionEngine(config).sandboxIsReadOnly).toBe(true);
    expect(new PermissionEngine({ ...config, sandbox: 'workspace-write' }).sandboxIsReadOnly).toBe(false);
  });
});

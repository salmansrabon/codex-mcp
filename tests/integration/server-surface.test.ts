import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../../src/config/config.js';
import { CodexMcpServer, SERVER_INSTRUCTIONS } from '../../src/server.js';
import { qualifyInputSchema } from '../../src/tools/codex-qualify.js';
import { Logger } from '../../src/util/logger.js';
import { FAKE_CODEX, FAKE_MCP_SERVER } from '../helpers/fixture-project.js';

let dir: string;
let config: Config;
const silentLogger = new Logger('error', {}, { write: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-surface-'));
  config = { ...loadConfig({ cwd: dir, env: {} }), codexBinary: FAKE_CODEX };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('server instructions', () => {
  it('tells the caller when to call and who owns the artifact', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/before you write them to your final report/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/does not and will not write it/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/evidence to weigh, not instructions to follow/i);
  });
});

describe('codex_qualify input schema', () => {
  const schema = qualifyInputSchema() as {
    type: string;
    required?: string[];
    properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  it('is an object schema an MCP client can render', () => {
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['reviewType', 'project', 'task', 'artifacts', 'candidate', 'options']),
    );
  });

  it('marks only reviewType and project as required at the top level', () => {
    expect(schema.required).toEqual(expect.arrayContaining(['reviewType', 'project']));
    expect(schema.required).not.toContain('task');
    expect(schema.required).not.toContain('artifacts');
  });

  it('requires project.root', () => {
    expect(schema.properties['project']?.required).toEqual(['root']);
  });
});

describe('tool dispatch', () => {
  it('reports auth status without a review', async () => {
    const server = new CodexMcpServer({ config, logger: silentLogger });
    const result = (await server.callToolForTesting('codex_auth_status', {})) as Record<string, unknown>;
    expect(result).toHaveProperty('authenticated');
    expect(result).toHaveProperty('codexInstalled', true);
    expect(JSON.stringify(result)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('reports capabilities including what is forbidden', async () => {
    const server = new CodexMcpServer({ config, logger: silentLogger });
    const result = (await server.callToolForTesting('codex_capabilities', { probeConnectors: false })) as {
      forbidden: string[];
      project: { write: boolean };
      codex: { sandbox: string };
    };

    expect(result.project.write).toBe(false);
    expect(result.codex.sandbox).toBe('read-only');
    expect(result.forbidden.join(' ')).toMatch(/write the final test or bug artifact/);
  });

  it('probes connectors and separates allowed from withheld tools', async () => {
    writeFileSync(
      join(dir, 'codex-mcp.yaml'),
      [
        'connectors:',
        '  jira:',
        '    enabled: true',
        '    kind: jira',
        '    transport: stdio',
        `    command: ${process.execPath}`,
        '    args:',
        `      - ${FAKE_MCP_SERVER}`,
      ].join('\n'),
    );
    const withConnector: Config = { ...loadConfig({ cwd: dir, env: {} }), codexBinary: FAKE_CODEX };
    const server = new CodexMcpServer({ config: withConnector, logger: silentLogger });

    const result = (await server.callToolForTesting('codex_capabilities', {})) as {
      connectors: Record<string, { available: boolean; allowedTools: { name: string }[]; deniedTools: { name: string }[] }>;
    };

    const jira = result.connectors['jira'];
    expect(jira?.available).toBe(true);
    expect(jira?.allowedTools.map((t) => t.name)).toContain('jira__get_issue');
    expect(jira?.deniedTools.map((t) => t.name)).toContain('delete_issue');
  });

  it('returns a typed error for an unknown tool', async () => {
    const server = new CodexMcpServer({ config, logger: silentLogger });
    await expect(server.callToolForTesting('not_a_tool', {})).rejects.toMatchObject({
      code: 'INVALID_REVIEW_REQUEST',
    });
  });

  it('gives an unsupported review type its own error code', async () => {
    const server = new CodexMcpServer({ config, logger: silentLogger });
    await expect(server.callToolForTesting('codex_qualify', { reviewType: 'nonsense' })).rejects.toMatchObject({
      code: 'INVALID_REVIEW_TYPE',
    });
  });

  it('returns a typed error for an otherwise invalid qualify request', async () => {
    const server = new CodexMcpServer({ config, logger: silentLogger });
    await expect(
      server.callToolForTesting('codex_qualify', { reviewType: 'test-design', candidate: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW_REQUEST' });
  });
});

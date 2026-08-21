import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, usableConnectors, type Config } from '../../src/config/config.js';
import { collectExternalEvidence } from '../../src/evidence/external-mcp.js';
import { BrokerServer } from '../../src/mcp-broker/broker-server.js';
import { discoverAll } from '../../src/mcp-broker/capability-discovery.js';
import { DownstreamClientManager } from '../../src/mcp-broker/client-manager.js';
import { AutoConsentGate } from '../../src/policy/consent.js';
import { PermissionEngine } from '../../src/policy/permission-engine.js';
import { Logger } from '../../src/util/logger.js';
import { FAKE_MCP_SERVER } from '../helpers/fixture-project.js';

let dir: string;
let callLog: string;
let config: Config;

const silentLogger = new Logger('error', {}, { write: () => {} });

function writeConfig(body: string): void {
  writeFileSync(join(dir, 'codex-mcp.yaml'), body);
  config = loadConfig({ cwd: dir, env: {} });
}

/**
 * The client manager deliberately gives a downstream server only PATH, HOME,
 * and the env its own config declares, so the call log has to be declared here
 * rather than inherited from the test process.
 */
function connectorYaml(name: string, kind: string, extra = ''): string {
  return [
    'connectors:',
    `  ${name}:`,
    '    enabled: true',
    `    kind: ${kind}`,
    '    transport: stdio',
    `    command: ${process.execPath}`,
    '    args:',
    `      - ${FAKE_MCP_SERVER}`,
    '    env:',
    `      FAKE_MCP_CALL_LOG: ${callLog}`,
    extra,
  ].join('\n');
}

function calls(): { name: string; arguments: Record<string, unknown> }[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-broker-'));
  callLog = join(dir, 'calls.jsonl');
  writeConfig(connectorYaml('jira', 'jira'));
});

afterEach(() => {
  delete process.env['FAKE_MCP_CALL_LOG'];
  rmSync(dir, { recursive: true, force: true });
});

async function discover(cfg: Config = config) {
  const connectors = usableConnectors(cfg);
  const manager = new DownstreamClientManager(connectors, silentLogger);
  try {
    return await discoverAll(connectors, manager, new PermissionEngine(cfg), silentLogger);
  } finally {
    await manager.closeAll();
  }
}

describe('capability discovery and filtering', () => {
  it('connects to a downstream server and lists its tools', async () => {
    const [discovery] = await discover();
    expect(discovery?.available).toBe(true);
    expect(discovery?.tools.length).toBeGreaterThan(5);
  });

  it('exposes read tools and withholds mutating ones', async () => {
    const [discovery] = await discover();
    const allowed = discovery!.tools.filter((tool) => tool.decision.effect === 'allow').map((t) => t.originalName);
    const denied = discovery!.tools.filter((tool) => tool.decision.effect !== 'allow').map((t) => t.originalName);

    expect(allowed).toEqual(expect.arrayContaining(['get_issue', 'search_issues', 'list_tables', 'read_query']));
    expect(denied).toEqual(
      expect.arrayContaining(['create_issue', 'add_comment', 'transition_issue', 'delete_issue', 'upload_file']),
    );
  });

  it('withholds unclassifiable tools by default', async () => {
    const [discovery] = await discover();
    const frobnicate = discovery!.tools.find((tool) => tool.originalName === 'frobnicate');
    expect(frobnicate?.decision.effect).toBe('deny');
    expect(frobnicate?.decision.risk).toBe('unknown');
  });

  it('lets an explicit allowlist rescue an unclassifiable tool', async () => {
    writeConfig(connectorYaml('jira', 'jira', '    allowTools:\n      - frobnicate'));
    const [discovery] = await discover();
    expect(discovery!.tools.find((t) => t.originalName === 'frobnicate')?.decision.effect).toBe('allow');
  });

  it('honors a deny list over a read classification', async () => {
    writeConfig(connectorYaml('jira', 'jira', '    denyTools:\n      - get_issue'));
    const [discovery] = await discover();
    expect(discovery!.tools.find((t) => t.originalName === 'get_issue')?.decision.effect).toBe('deny');
  });

  it('namespaces exposed tool names so two connectors cannot collide', async () => {
    const [discovery] = await discover();
    expect(discovery!.tools.find((t) => t.originalName === 'get_issue')?.exposedName).toBe('jira__get_issue');
  });

  it('attaches normalized capabilities where it can place a tool', async () => {
    const [discovery] = await discover();
    expect(discovery!.tools.find((t) => t.originalName === 'get_issue')?.normalizedCapability).toBe('requirement.read');
    expect(discovery!.tools.find((t) => t.originalName === 'search_issues')?.normalizedCapability).toBe(
      'requirement.search',
    );
  });

  it('records an unreachable connector as a limitation rather than failing', async () => {
    writeConfig(
      ['connectors:', '  jira:', '    enabled: true', '    kind: jira', '    command: definitely-not-a-real-binary'].join('\n'),
    );
    const external = await collectExternalEvidence(
      config,
      new PermissionEngine(config),
      { useJira: true, useDatabase: true, useExternalMcps: true },
      silentLogger,
      new AutoConsentGate(true),
      'test-review',
    );
    await external.manager.closeAll();
    expect(external.evidence.usable).toEqual([]);
    expect(external.evidence.limitations.join(' ')).toMatch(/unreachable/);
  });

  it('narrows connectors when the caller opts out of a source', async () => {
    const external = await collectExternalEvidence(
      config,
      new PermissionEngine(config),
      { useJira: false, useDatabase: true, useExternalMcps: true },
      silentLogger,
      new AutoConsentGate(true),
      'test-review',
    );
    await external.manager.closeAll();
    expect(external.connectors).toEqual([]);
  });
});

describe('BrokerServer call handling', () => {
  async function broker(cfg: Config = config): Promise<BrokerServer> {
    const server = new BrokerServer(cfg, usableConnectors(cfg), silentLogger);
    await server.refresh();
    return server;
  }

  it('forwards an allowed read call to the downstream server', async () => {
    const server = await broker();
    const result = await server.callTool('jira__get_issue', { key: 'DEV-123' });
    await server.close();

    expect(result.isError).toBe(false);
    expect(calls()).toEqual([{ name: 'get_issue', arguments: { key: 'DEV-123' } }]);
  });

  it('refuses a withheld tool and never reaches the downstream server', async () => {
    const server = await broker();
    const result = await server.callTool('jira__delete_issue', { key: 'DEV-123' });
    await server.close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DOWNSTREAM_MCP_PERMISSION_DENIED/);
    expect(result.content[0]?.text).toMatch(/not available/);
    expect(calls()).toEqual([]);
  });

  it('does not hand the downstream process the parent environment', async () => {
    // Declared env only: a connector must not inherit whatever happens to be
    // exported in the codex-mcp process.
    const inheritedLog = join(dir, 'inherited.jsonl');
    process.env['FAKE_MCP_CALL_LOG'] = inheritedLog;
    writeConfig(
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

    const server = await broker();
    await server.callTool('jira__get_issue', { key: 'DEV-1' });
    await server.close();

    expect(existsSync(inheritedLog)).toBe(false);
  });

  it('refuses a tool it was never told about', async () => {
    const server = await broker();
    const result = await server.callTool('jira__made_up_tool', {});
    await server.close();
    expect(result.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  it('redacts secrets in downstream responses before Codex sees them', async () => {
    const server = await broker();
    const result = await server.callTool('jira__get_issue', { key: 'DEV-1' });
    await server.close();
    // The fake echoes its arguments; a key-shaped value must not survive.
    expect(result.content[0]?.text).not.toMatch(/password/i);
  });
});

describe('BrokerServer database guarding', () => {
  beforeEach(() => {
    writeConfig(connectorYaml('database', 'database', '    maxRows: 25'));
  });

  async function broker(): Promise<BrokerServer> {
    const server = new BrokerServer(config, usableConnectors(config), silentLogger);
    await server.refresh();
    return server;
  }

  it('applies the row cap to a query that has none', async () => {
    const server = await broker();
    await server.callTool('database__read_query', { query: 'SELECT * FROM users' });
    await server.close();
    expect(calls()[0]?.arguments['query']).toBe('SELECT * FROM users LIMIT 25');
  });

  it('clamps a caller-supplied limit to the configured maximum', async () => {
    const server = await broker();
    await server.callTool('database__read_query', { query: 'SELECT 1 LIMIT 1', limit: 10_000 });
    await server.close();
    expect(calls()[0]?.arguments['limit']).toBe(25);
  });

  it('refuses a mutating statement before it reaches the database', async () => {
    const server = await broker();
    const result = await server.callTool('database__read_query', { query: 'DELETE FROM users' });
    await server.close();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/DB_QUERY_DENIED/);
    expect(result.content[0]?.text).toMatch(/not permitted/i);
    expect(calls()).toEqual([]);
  });

  it('refuses a multi-statement payload', async () => {
    const server = await broker();
    const result = await server.callTool('database__read_query', { query: 'SELECT 1; DROP TABLE users' });
    await server.close();
    expect(result.isError).toBe(true);
    expect(calls()).toEqual([]);
  });

  it('lets schema tools through untouched', async () => {
    const server = await broker();
    const result = await server.callTool('database__list_tables', {});
    await server.close();
    expect(result.isError).toBe(false);
    expect(calls()[0]?.name).toBe('list_tables');
  });

  it('keeps a generic SQL executor out of the exposed set entirely', async () => {
    const server = await broker();
    const result = await server.callTool('database__execute_query', { sql: 'SELECT 1' });
    await server.close();
    expect(result.isError).toBe(true);
    expect(calls()).toEqual([]);
  });
});

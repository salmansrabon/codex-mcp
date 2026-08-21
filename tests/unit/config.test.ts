import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandConfigValue, loadConfig, usableConnectors, userConfigDir } from '../../src/config/config.js';
import { findForbiddenEnvKeys, parseDotEnv } from '../../src/config/env.js';
import { CodexMcpError } from '../../src/errors/codex-mcp-error.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const emptyEnv: NodeJS.ProcessEnv = {};

describe('parseDotEnv', () => {
  it('parses plain, quoted, and exported assignments', () => {
    const parsed = parseDotEnv(['A=1', 'export B="two"', "C='three'", '# comment', 'D=four # trailing'].join('\n'));
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: 'four' });
  });

  it('ignores malformed lines rather than throwing', () => {
    expect(parseDotEnv('novalue\n=noKey\n1BAD=x\nOK=y')).toEqual({ OK: 'y' });
  });
});

describe('findForbiddenEnvKeys', () => {
  it('reports credential env vars codex-mcp must not consume', () => {
    expect(findForbiddenEnvKeys({ ACCESS_TOKEN: 'x', LOG_LEVEL: 'info' })).toEqual(['ACCESS_TOKEN']);
  });

  it('ignores empty values', () => {
    expect(findForbiddenEnvKeys({ REFRESH_TOKEN: '' })).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('produces a safe read-only default with no file and no env', () => {
    const config = loadConfig({ cwd: dir, env: emptyEnv });
    expect(config.sandbox).toBe('read-only');
    expect(config.ephemeral).toBe(true);
    expect(config.authMode).toBe('chatgpt');
    expect(config.maxPasses).toBe(2);
    expect(config.model).toBeUndefined();
    expect(config.permissions.projectWrite).toBe(false);
    expect(config.permissions.allowUnknownDownstreamTools).toBe(false);
    expect(config.connectors).toEqual({});
  });

  it('lets environment variables override the config file', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  model: from-file\n  maxPasses: 5\n');
    const config = loadConfig({ cwd: dir, env: { CODEX_MODEL: 'from-env' } });
    expect(config.model).toBe('from-env');
    expect(config.maxPasses).toBe(5);
  });

  it('warns when the model is set in both places and they disagree', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  model: from-file\n');
    const config = loadConfig({ cwd: dir, env: { CODEX_MODEL: 'from-env' } });
    expect(config.model).toBe('from-env');
    const warning = config.warnings.join(' ');
    expect(warning).toMatch(/two places/);
    expect(warning).toMatch(/from-env/);
    expect(warning).toMatch(/from-file/);
  });

  it('stays quiet when both places name the same model', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  model: same-model\n');
    const config = loadConfig({ cwd: dir, env: { CODEX_MODEL: 'same-model' } });
    expect(config.model).toBe('same-model');
    expect(config.warnings.join(' ')).not.toMatch(/two places/);
  });

  it('stays quiet when only one place names a model', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  model: only-file\n');
    expect(loadConfig({ cwd: dir, env: emptyEnv }).warnings.join(' ')).not.toMatch(/two places/);
    rmSync(join(dir, 'codex-mcp.yaml'));
    expect(loadConfig({ cwd: dir, env: { CODEX_MODEL: 'only-env' } }).warnings.join(' ')).not.toMatch(/two places/);
  });

  it('warns when the sandbox is not read-only instead of silently accepting it', () => {
    const config = loadConfig({ cwd: dir, env: { CODEX_SANDBOX: 'workspace-write' } });
    expect(config.sandbox).toBe('workspace-write');
    expect(config.warnings.join(' ')).toMatch(/read-only/);
  });

  it('warns about credential env vars and does not copy them into config', () => {
    const config = loadConfig({ cwd: dir, env: { CHATGPT_TOKEN: 'secret-value' } });
    expect(config.warnings.join(' ')).toMatch(/CHATGPT_TOKEN/);
    expect(JSON.stringify(config)).not.toContain('secret-value');
  });

  it('rejects an unknown auth mode', () => {
    expect(() => loadConfig({ cwd: dir, env: { AUTH_MODE: 'cookies' } })).toThrow(CodexMcpError);
  });

  it('rejects an invalid config file rather than falling back to defaults', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  maxPasses: "not a number"\n');
    expect(() => loadConfig({ cwd: dir, env: emptyEnv })).toThrow(/Invalid config file/);
  });

  it('fails loudly when an explicitly requested config file is missing', () => {
    expect(() => loadConfig({ cwd: dir, configPath: 'nope.yaml', env: emptyEnv })).toThrow(/not found/);
  });

  it('infers connector kinds from names', () => {
    writeFileSync(
      join(dir, 'codex-mcp.yaml'),
      [
        'connectors:',
        '  jira:',
        '    enabled: true',
        '    command: jira-mcp',
        '  reporting-db:',
        '    enabled: true',
        '    command: db-mcp',
        '  weird-thing:',
        '    enabled: true',
        '    command: other-mcp',
      ].join('\n'),
    );
    const config = loadConfig({ cwd: dir, env: emptyEnv });
    expect(config.connectors['jira']?.kind).toBe('jira');
    expect(config.connectors['reporting-db']?.kind).toBe('database');
    expect(config.connectors['weird-thing']?.kind).toBe('custom');
  });

  it('treats an enabled connector with no command as unusable and warns', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'connectors:\n  jira:\n    enabled: true\n');
    const config = loadConfig({ cwd: dir, env: emptyEnv });
    expect(usableConnectors(config)).toEqual([]);
    expect(config.warnings.join(' ')).toMatch(/no `command`/);
  });

  it('lets explicit YAML enablement outrank the coarse env toggle', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'connectors:\n  jira:\n    enabled: true\n    command: jira-mcp\n');
    const config = loadConfig({ cwd: dir, env: { JIRA_ENABLED: 'false' } });
    expect(config.connectors['jira']?.enabled).toBe(true);
  });

  it('applies DB limits from env when the connector does not set them', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'connectors:\n  database:\n    enabled: true\n    command: db-mcp\n');
    const config = loadConfig({ cwd: dir, env: { DB_MAX_ROWS: '25', DB_TIMEOUT_MS: '1000' } });
    expect(config.connectors['database']?.maxRows).toBe(25);
    expect(config.connectors['database']?.timeoutMs).toBe(1000);
  });
});

describe('requireModel', () => {
  it('is off by default, so an unpinned model is allowed', () => {
    expect(loadConfig({ cwd: dir, env: emptyEnv }).requireModel).toBe(false);
  });

  it('can be enabled from the config file or the environment', () => {
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  requireModel: true\n');
    expect(loadConfig({ cwd: dir, env: emptyEnv }).requireModel).toBe(true);
    expect(loadConfig({ cwd: dir, env: { CODEX_REQUIRE_MODEL: 'false' } }).requireModel).toBe(false);
  });
});

describe('user-level configuration discovery', () => {
  it('falls back to the user config directory when the cwd has no config', () => {
    const userDir = join(dir, 'xdg', 'codex-mcp');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'codex-mcp.yaml'), 'review:\n  model: from-user-dir\n');

    const emptyCwd = join(dir, 'some-project');
    mkdirSync(emptyCwd, { recursive: true });

    const config = loadConfig({ cwd: emptyCwd, env: { XDG_CONFIG_HOME: join(dir, 'xdg') } });
    expect(config.model).toBe('from-user-dir');
    expect(config.sources.configFile).toBe(join(userDir, 'codex-mcp.yaml'));
  });

  it('prefers a config in the working directory over the user one', () => {
    const userDir = join(dir, 'xdg', 'codex-mcp');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'codex-mcp.yaml'), 'review:\n  model: from-user-dir\n');
    writeFileSync(join(dir, 'codex-mcp.yaml'), 'review:\n  model: from-cwd\n');

    const config = loadConfig({ cwd: dir, env: { XDG_CONFIG_HOME: join(dir, 'xdg') } });
    expect(config.model).toBe('from-cwd');
  });

  it('honors CODEX_MCP_CONFIG and fails loudly when it points nowhere', () => {
    const explicit = join(dir, 'elsewhere.yaml');
    writeFileSync(explicit, 'review:\n  model: from-env-path\n');
    expect(loadConfig({ cwd: dir, env: { CODEX_MCP_CONFIG: explicit } }).model).toBe('from-env-path');

    expect(() => loadConfig({ cwd: dir, env: { CODEX_MCP_CONFIG: join(dir, 'nope.yaml') } })).toThrow(
      /CODEX_MCP_CONFIG/,
    );
  });

  it('derives the user directory from HOME when XDG_CONFIG_HOME is unset', () => {
    expect(userConfigDir({ HOME: '/home/someone' })).toBe('/home/someone/.config/codex-mcp');
    expect(userConfigDir({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/codex-mcp');
    expect(userConfigDir({})).toBeUndefined();
  });

  it('still works with no config file anywhere', () => {
    const emptyCwd = join(dir, 'bare');
    mkdirSync(emptyCwd, { recursive: true });
    const config = loadConfig({ cwd: emptyCwd, env: { HOME: join(dir, 'no-such-home') } });
    expect(config.sandbox).toBe('read-only');
    expect(config.sources.configFile).toBeUndefined();
  });
});

describe('portable configuration', () => {
  it('expands ${VAR} in connector paths', () => {
    writeFileSync(
      join(dir, 'codex-mcp.yaml'),
      ['connectors:', '  jira:', '    enabled: true', '    command: node', '    args:', '      - ${JIRA_MCP_PATH}/src/index.js', '    cwd: ${JIRA_MCP_PATH}'].join('\n'),
    );
    const config = loadConfig({ cwd: dir, env: { JIRA_MCP_PATH: '/opt/jira-mcp' } });
    expect(config.connectors['jira']?.args).toEqual(['/opt/jira-mcp/src/index.js']);
    expect(config.connectors['jira']?.cwd).toBe('/opt/jira-mcp');
  });

  it('uses ${VAR:-fallback} when the variable is unset', () => {
    expect(expandConfigValue('${NOPE:-/default/path}/x', {})).toBe('/default/path/x');
    expect(expandConfigValue('${SET:-/default}', { SET: '/actual' })).toBe('/actual');
  });

  it('expands a leading ~ to the home directory', () => {
    expect(expandConfigValue('~/db-mcp/dist/index.js', { HOME: '/home/qa' })).toBe('/home/qa/db-mcp/dist/index.js');
    expect(expandConfigValue('~', { HOME: '/home/qa' })).toBe('/home/qa');
    // Only a leading segment; a tilde mid-path is a real filename.
    expect(expandConfigValue('/opt/~backup/x', { HOME: '/home/qa' })).toBe('/opt/~backup/x');
  });

  it('leaves an unset variable verbatim rather than producing a broken path', () => {
    // "/src/index.js: not found" hides the cause; the literal ${VAR} names it.
    expect(expandConfigValue('${MISSING}/src/index.js', {})).toBe('${MISSING}/src/index.js');
  });

  it('warns about variables that resolve to nothing', () => {
    writeFileSync(
      join(dir, 'codex-mcp.yaml'),
      ['connectors:', '  jira:', '    enabled: true', '    command: node', '    args:', '      - ${JIRA_MCP_PATH}/src/index.js'].join('\n'),
    );
    const config = loadConfig({ cwd: dir, env: {} });
    expect(config.warnings.join(' ')).toMatch(/JIRA_MCP_PATH/);
  });

  it('does not warn when every variable has a fallback', () => {
    writeFileSync(
      join(dir, 'codex-mcp.yaml'),
      ['connectors:', '  jira:', '    enabled: true', '    command: node', '    args:', '      - ${JIRA_MCP_PATH:-/opt/jira}/src/index.js'].join('\n'),
    );
    const config = loadConfig({ cwd: dir, env: {} });
    expect(config.warnings.join(' ')).not.toMatch(/JIRA_MCP_PATH/);
    expect(config.connectors['jira']?.args).toEqual(['/opt/jira/src/index.js']);
  });
});

#!/usr/bin/env node
import { login } from '../src/auth/login.js';
import { AuthManager } from '../src/auth/auth-manager.js';
import { CodexRunner } from '../src/codex/codex-runner.js';
import { AutoConsentGate } from '../src/policy/consent.js';
import { loadConfig, usableConnectors, type Config } from '../src/config/config.js';
import type { AuthMode } from '../src/config/schema.js';
import { runDoctor, type CheckStatus } from '../src/doctor.js';
import { planInit, runInit } from '../src/init.js';
import { CodexMcpError, toCodexMcpError } from '../src/errors/codex-mcp-error.js';
import { BrokerServer } from '../src/mcp-broker/broker-server.js';
import { CodexMcpServer } from '../src/server.js';
import { handleCodexAsk } from '../src/tools/codex-ask.js';
import { Logger, rootLogger } from '../src/util/logger.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  /** Non-flag arguments, in order. `ask` takes its question this way. */
  positionals: string[];
}

const USAGE = `codex-mcp — an independent, read-only Codex quality gate for QA artifacts.

Usage:
  codex-mcp init [--model <id>] [--force] [--dry-run]
  codex-mcp start [--config <path>] [--cwd <dir>]
  codex-mcp login [--mode chatgpt|api] [--api-key <key>] [--force]
  codex-mcp auth-status [--json]
  codex-mcp doctor [--project <path>] [--config <path>] [--json]
  codex-mcp ask "<question>" [--config <path>] [--json]
  codex-mcp broker --connectors <a,b> [--cwd <dir>] [--config <path>]

Commands:
  init          Write codex-mcp's own config into ~/.config/codex-mcp/, detecting
                any downstream MCP servers already on this machine. Never
                overwrites without --force. This is the only command that writes
                anything; reviews are strictly read-only.
  start         Run the MCP server on stdio. This is what an MCP client launches.
  login         Authenticate through the official Codex CLI. Two modes:
                  --mode chatgpt  (default) browser sign-in to a ChatGPT subscription
                  --mode api      an OpenAI API key, read from --api-key, then
                                  OPENAI_API_KEY, then a hidden terminal prompt
                The key is piped to the Codex CLI over stdin and stored by it.
                codex-mcp never writes a credential to disk.
                Without --mode, AUTH_MODE from your configuration is used.
  auth-status   Report whether Codex is authenticated. Never prints credentials.
  doctor        Diagnose installation, auth, model, config, and connectors. Read-only.
  ask           Ask Codex a general question and print a prose answer. It reads no
                repository, so it cannot answer anything about your code. It DOES
                reach your configured evidence connectors read-only — running this
                command is taken as your consent to that. Connectors used and any
                withheld are reported on stderr.
  broker        Internal: the read-only evidence broker Codex connects to.
                Launched by codex-mcp; not intended to be run by hand.
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'start', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, flags, positionals };
}

function configFrom(flags: Record<string, string | boolean>): Config {
  return loadConfig({
    ...(typeof flags['cwd'] === 'string' ? { cwd: flags['cwd'] } : {}),
    ...(typeof flags['config'] === 'string' ? { configPath: flags['config'] } : {}),
  });
}

async function commandInit(flags: Record<string, string | boolean>): Promise<number> {
  const model = typeof flags['model'] === 'string' ? flags['model'] : undefined;

  if (flags['dry-run'] === true) {
    const plan = await planInit({ ...(model ? { model } : {}) });
    process.stdout.write(`Would write into ${plan.configDir}\n`);
    process.stdout.write(`  codex-mcp.yaml  ${plan.configExists ? '(exists, would be kept)' : '(new)'}\n`);
    process.stdout.write(`  .env            ${plan.envExists ? '(exists, would be kept)' : '(new)'}\n`);
    if (plan.detected.length === 0) {
      process.stdout.write('\nNo downstream MCP servers detected.\n');
    } else {
      process.stdout.write('\nDetected:\n');
      for (const c of plan.detected) process.stdout.write(`  ${c.name} (${c.kind}) -> ${c.path}/${c.entrypoint}\n`);
    }
    return 0;
  }

  const result = await runInit({ ...(model ? { model } : {}), force: flags['force'] === true });

  for (const path of result.written) process.stdout.write(`wrote   ${path}\n`);
  for (const path of result.skipped) process.stdout.write(`kept    ${path} (already exists; --force to replace)\n`);

  if (result.detected.length > 0) {
    process.stdout.write('\nDetected downstream MCP servers:\n');
    for (const c of result.detected) {
      process.stdout.write(`  ${c.name} (${c.kind})  ${c.path}/${c.entrypoint}\n`);
    }
    process.stdout.write('\nEach will ask for your approval once per session before a review uses it.\n');
  }

  if (!model && result.written.includes(result.configPath)) {
    process.stdout.write('\nNo model pinned. Set CODEX_MODEL in the .env above, or re-run with --model <id>.\n');
  }

  process.stdout.write('\nNext: codex-mcp login && codex-mcp doctor\n');
  return 0;
}

async function commandStart(flags: Record<string, string | boolean>): Promise<number> {
  const config = configFrom(flags);
  const logger = new Logger(config.logLevel);
  const server = new CodexMcpServer({ config, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.start();
  // The stdio transport keeps the process alive.
  return -1;
}

async function commandBroker(flags: Record<string, string | boolean>): Promise<number> {
  const config = configFrom(flags);
  const logger = new Logger(config.logLevel, { component: 'broker' });

  const requested = typeof flags['connectors'] === 'string' ? flags['connectors'].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const available = usableConnectors(config);
  const selected = requested.length > 0 ? available.filter((connector) => requested.includes(connector.name)) : available;

  if (requested.length > 0 && selected.length !== requested.length) {
    const missing = requested.filter((name) => !selected.some((connector) => connector.name === name));
    logger.warn('some requested connectors are not configured', { missing });
  }

  const broker = new BrokerServer(config, selected, logger);
  const shutdown = async (): Promise<void> => {
    await broker.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await broker.start();
  return -1;
}

async function commandLogin(flags: Record<string, string | boolean>): Promise<number> {
  const config = configFrom(flags);
  const mode = resolveLoginMode(flags, config);

  process.stderr.write(`Checking Codex authentication (mode: ${mode})...\n`);

  const result = await login({
    codexBinary: config.codexBinary,
    mode,
    ...(typeof flags['api-key'] === 'string' ? { apiKey: flags['api-key'] } : {}),
    force: flags['force'] === true,
  });

  process.stdout.write(`${result.message}\n`);
  if (!result.authenticated) {
    process.stdout.write(
      mode === 'api'
        ? '\nVerify the key is valid and has Codex access, then re-run `codex-mcp login --mode api`.\n'
        : '\nIf a browser did not open, run `codex login` directly and follow the prompts.\n',
    );
  } else if (result.authMode !== 'unknown' && result.authMode !== config.authMode) {
    process.stdout.write(
      `\nNote: your configuration has AUTH_MODE=${config.authMode}, but Codex is now authenticated with ` +
        `"${result.authMode}". Reviews fail while these disagree — set AUTH_MODE=${result.authMode}.\n`,
    );
  }
  return result.authenticated ? 0 : 1;
}

/** An explicit --mode wins; otherwise fall back to configured AUTH_MODE. */
function resolveLoginMode(flags: Record<string, string | boolean>, config: Config): AuthMode {
  if (flags['api-key'] !== undefined || flags['api'] === true) return 'api';
  const requested = flags['mode'];
  if (typeof requested === 'string') {
    if (requested !== 'chatgpt' && requested !== 'api') {
      throw new CodexMcpError('INVALID_REVIEW_REQUEST', `Unknown --mode "${requested}". Use "chatgpt" or "api".`);
    }
    return requested;
  }
  return config.authMode;
}

async function commandAuthStatus(flags: Record<string, string | boolean>): Promise<number> {
  const config = configFrom(flags);
  const authManager = new AuthManager({ codexBinary: config.codexBinary, expectedMode: config.authMode });
  const status = await authManager.publicStatus();

  if (flags['json'] === true) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    const loginCommand = config.authMode === 'api' ? 'codex-mcp login --mode api' : 'codex-mcp login';
    process.stdout.write(`Codex CLI:      ${status.codexInstalled ? (status.codexVersion ?? 'installed') : 'not found'}\n`);
    process.stdout.write(`Authenticated:  ${status.authenticated ? 'yes' : 'no'}\n`);
    process.stdout.write(`Active mode:    ${status.authMode}\n`);
    process.stdout.write(`Configured:     ${config.authMode}\n`);
    if (!status.authenticated) {
      process.stdout.write(`\nRun \`${loginCommand}\` to authenticate.\n`);
    } else if (!status.modeMatchesConfiguration) {
      process.stdout.write(
        `\nMode mismatch: reviews will fail. Run \`${loginCommand}\`, or set AUTH_MODE=${status.authMode}.\n`,
      );
    }
  }
  return status.authenticated ? 0 : 1;
}

async function commandAsk(
  flags: Record<string, string | boolean>,
  positionals: readonly string[],
): Promise<number> {
  const question = positionals.join(' ').trim();
  if (question === '') {
    process.stderr.write('Usage: codex-mcp ask "<question>"\n');
    return 2;
  }

  const config = configFrom(flags);
  const logger = new Logger(config.logLevel);
  const authManager = new AuthManager({ codexBinary: config.codexBinary, expectedMode: config.authMode });
  const runner = new CodexRunner({ config, logger });

  // Typing this command IS the request to reach the configured connectors, so
  // the CLI consents on the operator's behalf. A `trusted` connector needs no
  // gate anywhere; everything else here relies on the terminal being the human.
  const consent = new AutoConsentGate(true, 'Consent given by running `codex-mcp ask` in a terminal.');

  const result = await handleCodexAsk(
    { runner, config, logger, auth: authManager, consent },
    { question },
  );

  if (flags['json'] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.answer}\n`);
  }
  return 0;
}

async function commandDoctor(flags: Record<string, string | boolean>): Promise<number> {
  const config = configFrom(flags);
  const logger = new Logger(config.logLevel);
  const report = await runDoctor({
    config,
    logger,
    ...(typeof flags['project'] === 'string' ? { projectRoot: flags['project'] } : {}),
  });

  if (flags['json'] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  const marks: Record<CheckStatus, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ', skip: ' skip ' };
  process.stdout.write('codex-mcp doctor\n\n');
  for (const check of report.checks) {
    process.stdout.write(`[${marks[check.status]}] ${check.name}\n           ${check.detail}\n`);
    if (check.remediation) process.stdout.write(`           -> ${check.remediation}\n`);
  }
  process.stdout.write(`\n${report.ok ? 'No blocking problems found.' : 'Blocking problems found; see FAIL entries above.'}\n`);
  return report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));

  if (flags['help'] === true || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  let exitCode: number;
  try {
    switch (command) {
      case 'init':
        exitCode = await commandInit(flags);
        break;
      case 'start':
        exitCode = await commandStart(flags);
        break;
      case 'broker':
        exitCode = await commandBroker(flags);
        break;
      case 'login':
        exitCode = await commandLogin(flags);
        break;
      case 'auth-status':
        exitCode = await commandAuthStatus(flags);
        break;
      case 'doctor':
        exitCode = await commandDoctor(flags);
        break;
      case 'ask':
        exitCode = await commandAsk(flags, positionals);
        break;
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        exitCode = 2;
    }
  } catch (err) {
    const error = err instanceof CodexMcpError ? err : toCodexMcpError(err);
    const payload = error.toPayload();
    process.stderr.write(`${payload.code}: ${payload.message}\n`);
    if (payload.remediation) process.stderr.write(`${payload.remediation}\n`);
    rootLogger.debug('cli command failed', { code: payload.code });
    exitCode = 1;
  }

  // -1 means the command owns the event loop (a long-running server).
  if (exitCode >= 0) process.exit(exitCode);
}

void main();

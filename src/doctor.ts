import { AuthManager } from './auth/auth-manager.js';
import { usableConnectors, type Config } from './config/config.js';
import { collectRepositoryEvidence } from './evidence/repository.js';
import { discoverAll } from './mcp-broker/capability-discovery.js';
import { DownstreamClientManager } from './mcp-broker/client-manager.js';
import { PermissionEngine } from './policy/permission-engine.js';
import { isReadableDirectory } from './util/fs.js';
import type { Logger } from './util/logger.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const MIN_NODE_MAJOR = 20;

/**
 * `codex-mcp doctor` (PLAN.md §18).
 *
 * Diagnoses; never repairs. It runs only read-only probes, so it is safe to run
 * against a live project — including one with uncommitted work.
 */
export async function runDoctor(options: {
  config: Config;
  logger: Logger;
  /** Optional project to validate read access against. */
  projectRoot?: string;
}): Promise<DoctorReport> {
  const { config, logger } = options;
  const checks: DoctorCheck[] = [];

  checks.push(checkNode());

  const authManager = new AuthManager({ codexBinary: config.codexBinary, expectedMode: config.authMode });
  const installation = await authManager.checkInstallation();
  checks.push({
    name: 'Codex CLI',
    status: installation.installed ? 'ok' : 'fail',
    detail: installation.installed
      ? `Found: ${installation.version ?? 'version unknown'}`
      : (installation.error ?? 'Not found.'),
    ...(installation.installed ? {} : { remediation: 'Install the Codex CLI and ensure `codex` is on PATH.' }),
  });

  if (installation.installed) {
    const status = await authManager.getStatus({ force: true });
    const loginHint =
      config.authMode === 'api' ? 'Run `codex-mcp login --mode api`.' : 'Run `codex-mcp login`.';
    checks.push({
      name: 'Codex authentication',
      status: status.authenticated ? 'ok' : 'fail',
      detail: status.authenticated ? `Authenticated (mode: ${status.authMode}).` : 'Not authenticated.',
      ...(status.authenticated ? {} : { remediation: loginHint }),
    });

    const modeMismatch =
      status.authenticated && status.authMode !== 'unknown' && status.authMode !== config.authMode;
    checks.push({
      name: 'Auth mode',
      status: modeMismatch ? 'fail' : 'ok',
      detail: modeMismatch
        ? `AUTH_MODE is "${config.authMode}" but Codex is authenticated with "${status.authMode}".`
        : `AUTH_MODE=${config.authMode}${status.authMode === 'unknown' ? ' (active mode not reported by the CLI)' : ''}`,
      ...(modeMismatch ? { remediation: `${loginHint} Or set AUTH_MODE=${status.authMode} to match.` } : {}),
    });
  } else {
    checks.push({ name: 'Codex authentication', status: 'skip', detail: 'Skipped: Codex CLI unavailable.' });
  }

  checks.push({
    name: 'Model configuration',
    status: config.model ? 'ok' : config.requireModel ? 'fail' : 'warn',
    detail: config.model
      ? `CODEX_MODEL=${config.model}`
      : config.requireModel
        ? 'No model configured, but `requireModel` is set: every review will fail.'
        : 'No model configured; Codex will use its own default and codex-mcp will not substitute one.',
    ...(config.model ? {} : { remediation: 'Set CODEX_MODEL to pin a model explicitly.' }),
  });

  checks.push({
    name: 'Sandbox',
    status: config.sandbox === 'read-only' ? 'ok' : 'warn',
    detail: `Codex sandbox is "${config.sandbox}".`,
    ...(config.sandbox === 'read-only'
      ? {}
      : { remediation: 'Set CODEX_SANDBOX=read-only; the non-mutating guarantee only holds there.' }),
  });

  checks.push({
    name: 'Configuration file',
    status: config.sources.configFile ? 'ok' : 'warn',
    detail: config.sources.configFile
      ? `Loaded ${config.sources.configFile}`
      : 'No codex-mcp.yaml found; using environment variables and defaults.',
  });

  for (const warning of config.warnings) {
    checks.push({ name: 'Configuration warning', status: 'warn', detail: warning });
  }

  const permissions = new PermissionEngine(config);
  const connectors = usableConnectors(config);
  const configured = Object.values(config.connectors);

  if (configured.length === 0) {
    checks.push({
      name: 'Downstream connectors',
      status: 'ok',
      detail: 'None configured. Reviews will use repository and git evidence only.',
    });
  } else if (connectors.length === 0) {
    checks.push({
      name: 'Downstream connectors',
      status: 'warn',
      detail: `${configured.length} connector(s) configured but none are enabled with a usable command or url.`,
    });
  } else {
    const manager = new DownstreamClientManager(connectors, logger);
    try {
      const discoveries = await discoverAll(connectors, manager, permissions, logger);
      for (const discovery of discoveries) {
        const allowed = discovery.tools.filter((tool) => tool.decision.effect === 'allow');
        const denied = discovery.tools.length - allowed.length;
        if (!discovery.available) {
          checks.push({
            name: `Connector: ${discovery.connector.name}`,
            status: 'fail',
            detail: discovery.error ?? 'Unavailable.',
            remediation: 'Check the connector command/url in codex-mcp.yaml and that the server starts on its own.',
          });
          continue;
        }
        checks.push({
          name: `Connector: ${discovery.connector.name}`,
          status: allowed.length > 0 ? 'ok' : 'warn',
          detail: `${allowed.length} read-only tool(s) exposed, ${denied} withheld by policy.`,
          ...(allowed.length === 0
            ? { remediation: 'No tool classified as read-only. Add explicit names to `allowTools` if they really are.' }
            : {}),
        });
      }
    } finally {
      await manager.closeAll();
    }
  }

  if (options.projectRoot) {
    checks.push(await checkProject(options.projectRoot));
  } else {
    checks.push({ name: 'Project access', status: 'skip', detail: 'No project supplied. Pass --project <path> to check one.' });
  }

  const ok = checks.every((check) => check.status !== 'fail');
  return { ok, checks };
}

function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return {
    name: 'Node.js',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    ...(major >= MIN_NODE_MAJOR ? {} : { remediation: `codex-mcp requires Node ${MIN_NODE_MAJOR} or newer.` }),
  };
}

async function checkProject(projectRoot: string): Promise<DoctorCheck> {
  if (!(await isReadableDirectory(projectRoot))) {
    return {
      name: 'Project access',
      status: 'fail',
      detail: `Not a readable directory: ${projectRoot}`,
      remediation: 'Pass an absolute path to an existing project directory.',
    };
  }
  const repository = await collectRepositoryEvidence(projectRoot);
  return {
    name: 'Project access',
    status: 'ok',
    detail:
      `Readable. git: ${repository.hasGit ? 'yes' : 'no'}; ` +
      `stack: ${repository.stackHints.join(', ') || 'unknown'}; ` +
      `test dirs: ${repository.testDirectories.join(', ') || 'none at top level'}`,
  };
}

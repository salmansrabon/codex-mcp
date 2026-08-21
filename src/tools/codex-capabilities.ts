import type { AuthManager } from '../auth/auth-manager.js';
import type { Config } from '../config/config.js';
import { usableConnectors } from '../config/config.js';
import { discoverAll } from '../mcp-broker/capability-discovery.js';
import { DownstreamClientManager } from '../mcp-broker/client-manager.js';
import type { PermissionEngine } from '../policy/permission-engine.js';
import type { Logger } from '../util/logger.js';

export const CODEX_CAPABILITIES_TOOL_NAME = 'codex_capabilities';

export const CODEX_CAPABILITIES_DESCRIPTION = `Report what evidence this codex-mcp instance can actually reach, and what it is forbidden to do.

Diagnostic only — it runs no review and changes nothing. Use it to find out, before you rely on it,
whether the requirement system or database is available for independent verification, and which
downstream tools were withheld by policy.

Probing connectors takes a moment; pass \`probeConnectors: false\` for a configuration-only answer.`;

export const CODEX_CAPABILITIES_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    probeConnectors: {
      type: 'boolean',
      description: 'Connect to downstream MCP servers to list their real tools. Defaults to true.',
    },
  },
  additionalProperties: false,
} as const;

export async function handleCodexCapabilities(
  config: Config,
  permissions: PermissionEngine,
  authManager: AuthManager,
  logger: Logger,
  args: { probeConnectors?: boolean } = {},
): Promise<unknown> {
  const probe = args.probeConnectors ?? true;
  const auth = await authManager.publicStatus();
  const connectors = usableConnectors(config);

  const base = {
    codex: {
      installed: auth.codexInstalled,
      authenticated: auth.authenticated,
      authMode: auth.authMode,
      ...(auth.codexVersion ? { version: auth.codexVersion } : {}),
      model: config.model ?? null,
      reasoningEffort: config.reasoningEffort,
      sandbox: config.sandbox,
      ephemeral: config.ephemeral,
    },
    project: {
      read: config.permissions.projectRead,
      git: config.permissions.gitRead,
      write: false,
    },
    review: {
      types: ['test-design', 'bugs', 'combined'],
      maxPasses: config.maxPasses,
      maxCandidateItems: config.maxCandidateItems,
      maxConcurrentReviews: config.maxConcurrentReviews,
    },
    permissions: permissions.describe(),
    forbidden: [
      'edit or create files',
      'delete files',
      'git add / commit / push / checkout / reset',
      'create, edit, comment on, or transition issues',
      'INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE',
      'upload or delete remote files',
      'create or update test-management cases',
      'write the final test or bug artifact',
    ],
    warnings: config.warnings,
  };

  if (!probe) {
    return {
      ...base,
      connectors: Object.fromEntries(
        Object.values(config.connectors).map((connector) => [
          connector.name,
          { kind: connector.kind, enabled: connector.enabled, probed: false },
        ]),
      ),
    };
  }

  const manager = new DownstreamClientManager(connectors, logger);
  try {
    const discoveries = await discoverAll(connectors, manager, permissions, logger);
    const detail = Object.fromEntries(
      discoveries.map((discovery) => {
        const allowed = discovery.tools.filter((tool) => tool.decision.effect === 'allow');
        const denied = discovery.tools.filter((tool) => tool.decision.effect !== 'allow');
        return [
          discovery.connector.name,
          {
            kind: discovery.connector.kind,
            enabled: discovery.connector.enabled,
            probed: true,
            available: discovery.available,
            ...(discovery.error ? { error: discovery.error } : {}),
            allowedTools: allowed.map((tool) => ({
              name: tool.exposedName,
              ...(tool.normalizedCapability ? { capability: tool.normalizedCapability } : {}),
            })),
            deniedTools: denied.map((tool) => ({
              name: tool.originalName,
              risk: tool.decision.risk,
              reason: tool.decision.reason,
            })),
          },
        ];
      }),
    );

    // Connectors that are configured but disabled never get probed; list them anyway.
    for (const connector of Object.values(config.connectors)) {
      if (detail[connector.name]) continue;
      detail[connector.name] = { kind: connector.kind, enabled: connector.enabled, probed: false } as never;
    }

    return { ...base, connectors: detail };
  } finally {
    await manager.closeAll();
  }
}

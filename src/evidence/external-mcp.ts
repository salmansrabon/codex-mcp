import type { Config, ConnectorConfig } from '../config/config.js';
import { usableConnectors } from '../config/config.js';
import type { ConsentGate } from '../policy/consent.js';
import type { PermissionEngine } from '../policy/permission-engine.js';
import { discoverAll, type BrokeredTool } from '../mcp-broker/capability-discovery.js';
import { DownstreamClientManager } from '../mcp-broker/client-manager.js';
import { filterCapabilities } from '../mcp-broker/policy-filter.js';
import type { Logger } from '../util/logger.js';

export interface ConnectorAvailability {
  name: string;
  kind: string;
  available: boolean;
  allowedTools: string[];
  deniedTools: { name: string; reason: string }[];
  normalizedCapabilities: string[];
  error?: string;
}

export interface ExternalEvidence {
  connectors: ConnectorAvailability[];
  /** Connectors Codex may actually use during this review. */
  usable: string[];
  limitations: string[];
}

export interface ConnectorSelection {
  useJira: boolean;
  useDatabase: boolean;
  useExternalMcps: boolean;
}

/** Purpose shown to the user when asking for connector access. */
function purposeFor(kind: string): string {
  switch (kind) {
    case 'jira':
      return 'read the requirement independently instead of trusting the summary it was given';
    case 'database':
      return 'verify persistence, relationships, and tenant ownership against real data';
    default:
      return 'gather supporting evidence for this review';
  }
}

/**
 * Decide which connectors this review may reach, and probe them.
 *
 * The caller's `options` can only ever *narrow* the set: a request cannot
 * enable a connector the operator did not configure (PLAN.md §7.4).
 */
export async function collectExternalEvidence(
  config: Config,
  permissions: PermissionEngine,
  selection: ConnectorSelection,
  logger: Logger,
  consent: ConsentGate,
  reviewId: string,
): Promise<{ evidence: ExternalEvidence; connectors: ConnectorConfig[]; manager: DownstreamClientManager }> {
  const configured = usableConnectors(config);
  const requested = configured.filter((connector) => isSelected(connector, selection));

  const consentLimitations: string[] = [];
  const selected: ConnectorConfig[] = [];

  // Consent is resolved before any connection is opened, so a declined
  // connector's process is never even started.
  for (const connector of requested) {
    const decision = await consent.request({ connector, reviewId, purpose: purposeFor(connector.kind) });
    if (decision.granted) selected.push(connector);
    else consentLimitations.push(`Connector "${connector.name}" was not used: ${decision.reason}`);
  }

  const manager = new DownstreamClientManager(selected, logger);

  if (selected.length === 0) {
    return {
      evidence: { connectors: [], usable: [], limitations: consentLimitations },
      connectors: [],
      manager,
    };
  }

  const discoveries = await discoverAll(selected, manager, permissions, logger);
  const filtered = filterCapabilities(discoveries);

  const connectors: ConnectorAvailability[] = discoveries.map((discovery) => {
    const allowed = discovery.tools.filter((tool) => tool.decision.effect === 'allow');
    const denied = discovery.tools.filter((tool) => tool.decision.effect !== 'allow');
    return {
      name: discovery.connector.name,
      kind: discovery.connector.kind,
      available: discovery.available && allowed.length > 0,
      allowedTools: allowed.map((tool) => tool.exposedName),
      deniedTools: denied.map((tool) => ({ name: tool.originalName, reason: tool.decision.reason })),
      normalizedCapabilities: uniqueCapabilities(allowed),
      ...(discovery.error ? { error: discovery.error } : {}),
    };
  });

  const limitations: string[] = [...consentLimitations];
  for (const entry of filtered.unavailableConnectors) {
    limitations.push(`Connector "${entry.name}" was unreachable (${entry.error}); its evidence was not consulted.`);
  }
  for (const connector of connectors) {
    if (connector.available || connector.error) continue;
    limitations.push(`Connector "${connector.name}" exposed no policy-approved read-only tools.`);
  }

  const usable = connectors.filter((connector) => connector.available).map((connector) => connector.name);
  const usableConfigs = selected.filter((connector) => usable.includes(connector.name));

  return { evidence: { connectors, usable, limitations }, connectors: usableConfigs, manager };
}

function isSelected(connector: ConnectorConfig, selection: ConnectorSelection): boolean {
  switch (connector.kind) {
    case 'jira':
      return selection.useJira;
    case 'database':
      return selection.useDatabase;
    default:
      return selection.useExternalMcps;
  }
}

function uniqueCapabilities(tools: readonly BrokeredTool[]): string[] {
  const set = new Set<string>();
  for (const tool of tools) {
    if (tool.normalizedCapability) set.add(tool.normalizedCapability);
  }
  return [...set];
}

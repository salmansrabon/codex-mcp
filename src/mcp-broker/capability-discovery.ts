import type { ConnectorConfig } from '../config/config.js';
import type { PermissionEngine } from '../policy/permission-engine.js';
import type { PolicyDecision } from '../policy/types.js';
import type { Logger } from '../util/logger.js';
import { classifyTool, type ToolDescriptor } from './capability-classifier.js';
import type { DownstreamClientManager } from './client-manager.js';
import { normalizeCapability, type NormalizedCapability } from './capability-normalizer.js';

export interface BrokeredTool {
  connector: string;
  connectorKind: string;
  /** Name as exposed to Codex: `<connector>__<tool>`, so names cannot collide. */
  exposedName: string;
  originalName: string;
  description?: string;
  inputSchema?: unknown;
  decision: PolicyDecision;
  rationale: string;
  normalizedCapability?: NormalizedCapability;
}

export interface ConnectorDiscovery {
  connector: ConnectorConfig;
  available: boolean;
  error?: string;
  tools: BrokeredTool[];
}

export const EXPOSED_NAME_SEPARATOR = '__';

export function exposedToolName(connector: string, tool: string): string {
  return `${sanitize(connector)}${EXPOSED_NAME_SEPARATOR}${sanitize(tool)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Discover downstream tools and classify each one (PLAN.md §8.1–§8.3).
 *
 * Discovery never throws for an unreachable connector: an evidence source being
 * down is a limitation to report, not a reason to abandon the review.
 */
export async function discoverConnector(
  connector: ConnectorConfig,
  manager: DownstreamClientManager,
  permissions: PermissionEngine,
  logger: Logger,
): Promise<ConnectorDiscovery> {
  let rawTools: ToolDescriptor[];
  try {
    rawTools = await manager.listTools(connector.name);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('connector discovery failed', { connector: connector.name, error });
    return { connector, available: false, error, tools: [] };
  }

  const tools: BrokeredTool[] = rawTools.map((tool) => {
    const classification = classifyTool(tool);
    const decision = permissions.evaluateDownstreamTool(connector, tool.name, classification.risk);
    const normalized = normalizeCapability(connector.kind, tool.name);
    return {
      connector: connector.name,
      connectorKind: connector.kind,
      exposedName: exposedToolName(connector.name, tool.name),
      originalName: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      decision,
      rationale: classification.rationale,
      ...(normalized ? { normalizedCapability: normalized } : {}),
    };
  });

  logger.debug('connector discovery complete', {
    connector: connector.name,
    total: tools.length,
    allowed: tools.filter((t) => t.decision.effect === 'allow').length,
  });

  return { connector, available: true, tools };
}

export async function discoverAll(
  connectors: readonly ConnectorConfig[],
  manager: DownstreamClientManager,
  permissions: PermissionEngine,
  logger: Logger,
): Promise<ConnectorDiscovery[]> {
  return Promise.all(connectors.map((connector) => discoverConnector(connector, manager, permissions, logger)));
}

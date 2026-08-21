import type { BrokeredTool, ConnectorDiscovery } from './capability-discovery.js';

export interface FilteredCapabilities {
  allowed: BrokeredTool[];
  denied: BrokeredTool[];
  unavailableConnectors: { name: string; error: string }[];
}

/**
 * Reduce discovery output to the set Codex is actually allowed to see.
 *
 * Denied tools are kept (without their schemas) purely so `codex_capabilities`
 * and the audit log can explain *why* something is missing — they are never
 * registered as callable.
 */
export function filterCapabilities(discoveries: readonly ConnectorDiscovery[]): FilteredCapabilities {
  const allowed: BrokeredTool[] = [];
  const denied: BrokeredTool[] = [];
  const unavailableConnectors: { name: string; error: string }[] = [];

  for (const discovery of discoveries) {
    if (!discovery.available) {
      unavailableConnectors.push({ name: discovery.connector.name, error: discovery.error ?? 'unavailable' });
      continue;
    }
    for (const tool of discovery.tools) {
      if (tool.decision.effect === 'allow') allowed.push(tool);
      else denied.push(tool);
    }
  }

  return { allowed, denied, unavailableConnectors };
}

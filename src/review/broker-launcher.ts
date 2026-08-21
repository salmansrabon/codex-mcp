import { fileURLToPath } from 'node:url';

import type { Config, ConnectorConfig } from '../config/config.js';
import type { BrokerLaunchSpec } from '../codex/command-builder.js';

export const BROKER_SERVER_NAME = 'codex_mcp_evidence';

/**
 * Describe how Codex should launch the evidence broker.
 *
 * The broker is a child of the *Codex* process, not of codex-mcp, so it cannot
 * be handed live objects. It re-loads configuration from the same working
 * directory instead of receiving a serialized copy — which keeps connector
 * credentials out of any temp file on disk (PLAN.md §5.4, §23).
 */
export function buildBrokerLaunchSpec(config: Config, connectors: readonly ConnectorConfig[]): BrokerLaunchSpec | undefined {
  if (connectors.length === 0) return undefined;

  const entrypoint = resolveEntrypoint();
  const args = [
    entrypoint,
    'broker',
    '--cwd',
    config.sources.cwd,
    '--connectors',
    connectors.map((connector) => connector.name).join(','),
  ];
  if (config.sources.configFile) {
    args.push('--config', config.sources.configFile);
  }

  return {
    name: BROKER_SERVER_NAME,
    command: process.execPath,
    args,
    env: { LOG_LEVEL: config.logLevel },
  };
}

/**
 * Path to the codex-mcp CLI entrypoint. Derived from this module's own location
 * so it works whether codex-mcp is installed globally, linked, or run from a
 * build directory.
 */
function resolveEntrypoint(): string {
  const here = fileURLToPath(import.meta.url);
  // dist/src/review/broker-launcher.js -> dist/bin/codex-mcp.js
  return here.replace(/([\\/])src[\\/]review[\\/]broker-launcher\.js$/, '$1bin$1codex-mcp.js');
}

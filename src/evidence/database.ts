import type { ConnectorConfig } from '../config/config.js';

export interface DatabaseEvidencePlan {
  available: boolean;
  connectorName?: string;
  maxRows?: number;
  timeoutMs?: number;
  /** Guidance injected into the prompt so Codex queries only when it helps. */
  guidance: string[];
  limitations: string[];
}

/**
 * Database evidence planning (PLAN.md §11.6).
 *
 * The database is consulted only when it can materially change a verdict.
 * codex-mcp does not run queries itself: Codex issues them through the broker,
 * where every statement is checked against the SQL policy.
 */
export function planDatabaseEvidence(connectors: readonly ConnectorConfig[]): DatabaseEvidencePlan {
  const connector = connectors[0];
  if (!connector) {
    return {
      available: false,
      guidance: [],
      limitations: ['No database connector is configured; persistence and data-integrity claims cannot be verified against real data.'],
    };
  }

  return {
    available: true,
    connectorName: connector.name,
    maxRows: connector.maxRows,
    timeoutMs: connector.timeoutMs,
    guidance: [
      'Query the database only when it changes a verdict: persistence behavior, relationships, tenant ownership, state transitions, schema/migration behavior, data integrity, or verifying a reported bug.',
      'Do not browse the database for general context.',
      `Only SELECT / SHOW / DESCRIBE / EXPLAIN are permitted, one statement per call, capped at ${connector.maxRows} rows.`,
      'Any attempt to INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or call a mutating procedure is refused by policy.',
    ],
    limitations: [],
  };
}

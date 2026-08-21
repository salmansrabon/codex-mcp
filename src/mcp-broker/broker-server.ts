import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Config, ConnectorConfig } from '../config/config.js';
import { ErrorCodes, type ErrorCode } from '../errors/codes.js';
import { PermissionEngine } from '../policy/permission-engine.js';
import { Logger } from '../util/logger.js';
import { redactValue } from '../util/redact.js';
import { discoverAll, type BrokeredTool } from './capability-discovery.js';
import { DownstreamClientManager } from './client-manager.js';
import { filterCapabilities } from './policy-filter.js';

/**
 * The evidence broker Codex talks to (PLAN.md §8).
 *
 * Codex never gets a direct connection to Jira, the database, or any other
 * downstream MCP. It connects to this process instead, which:
 *
 *   - exposes only tools that passed classification and policy;
 *   - re-checks policy on every call, not just at discovery time;
 *   - applies SQL statement policy to database calls;
 *   - refuses anything it does not recognize.
 *
 * Re-checking at call time matters: a downstream server can change its tool
 * list mid-session, and a name that was safe at discovery must not become a
 * standing permit.
 */
export class BrokerServer {
  private readonly server: Server;
  private readonly manager: DownstreamClientManager;
  private readonly permissions: PermissionEngine;
  private allowedTools = new Map<string, BrokeredTool>();
  private started = false;

  constructor(
    private readonly config: Config,
    private readonly connectors: readonly ConnectorConfig[],
    private readonly logger: Logger,
  ) {
    this.permissions = new PermissionEngine(config);
    this.manager = new DownstreamClientManager(connectors, logger);
    this.server = new Server(
      { name: 'codex-mcp-evidence', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'Read-only evidence access brokered by codex-mcp. Every tool here is non-mutating. ' +
          'Attempts to write to any external system are refused by policy, not by convention.',
      },
    );
    this.registerHandlers();
  }

  /** Discover and cache the allowed tool set. Safe to call repeatedly. */
  async refresh(): Promise<void> {
    const discoveries = await discoverAll(this.connectors, this.manager, this.permissions, this.logger);
    const { allowed, denied, unavailableConnectors } = filterCapabilities(discoveries);

    this.allowedTools = new Map(allowed.map((tool) => [tool.exposedName, tool]));

    this.logger.info('broker capabilities resolved', {
      allowed: allowed.length,
      denied: denied.length,
      unavailable: unavailableConnectors.map((c) => c.name),
    });
    for (const tool of denied) {
      this.logger.debug('downstream tool denied', {
        tool: tool.exposedName,
        risk: tool.decision.risk,
        rule: tool.decision.rule,
      });
    }
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.started) await this.refresh();
      return {
        tools: [...this.allowedTools.values()].map((tool) => ({
          name: tool.exposedName,
          description: buildDescription(tool),
          inputSchema: normalizeInputSchema(tool.inputSchema),
        })),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return this.callTool(name, args);
    });
  }

  /** Exposed for tests: run a brokered call without a transport. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: { type: 'text'; text: string }[] }> {
    const tool = this.allowedTools.get(name);
    if (!tool) {
      return refusal(
        ErrorCodes.DOWNSTREAM_MCP_PERMISSION_DENIED,
        `Tool "${name}" is not available. codex-mcp exposes only policy-approved read-only evidence tools.`,
      );
    }

    const connector = this.manager.getConnector(tool.connector);
    if (!connector) {
      return refusal(ErrorCodes.DOWNSTREAM_MCP_UNAVAILABLE, `Connector "${tool.connector}" is no longer configured.`);
    }

    // Re-evaluate: discovery-time approval is not a standing permit.
    const decision = this.permissions.evaluateDownstreamTool(connector, tool.originalName, tool.decision.risk);
    if (decision.effect !== 'allow') {
      this.logger.warn('brokered call refused at call time', { tool: name, rule: decision.rule });
      return refusal(ErrorCodes.DOWNSTREAM_MCP_PERMISSION_DENIED, decision.reason);
    }

    let effectiveArgs = args;
    if (connector.kind === 'database') {
      const guarded = this.guardDatabaseArgs(connector, args);
      if ('refusal' in guarded) {
        this.logger.warn('database call refused by SQL policy', { tool: name, reason: guarded.refusal });
        return refusal(ErrorCodes.DB_QUERY_DENIED, guarded.refusal);
      }
      effectiveArgs = guarded.args;
    }

    try {
      const result = await this.manager.callTool(tool.connector, tool.originalName, effectiveArgs);
      const payload = result.structuredContent ?? result.content;
      return {
        isError: result.isError,
        content: [{ type: 'text', text: stringify(redactValue(payload)) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('brokered call failed', { tool: name, error: message });
      // A timed-out database read is worth distinguishing: it usually means the
      // query was too broad, which the reviewer can act on by narrowing it.
      const code: ErrorCode =
        connector.kind === 'database' && /timed out/i.test(message)
          ? ErrorCodes.DB_QUERY_TIMEOUT
          : ErrorCodes.DOWNSTREAM_MCP_UNAVAILABLE;
      return refusal(code, message);
    }
  }

  /**
   * Apply SQL policy to whichever argument carries the statement. Tools name
   * this field differently (`query`, `sql`, `statement`), so all common spellings
   * are checked and a tool that carries none is refused rather than guessed at.
   */
  private guardDatabaseArgs(
    connector: ConnectorConfig,
    args: Record<string, unknown>,
  ): { args: Record<string, unknown> } | { refusal: string } {
    const sqlKeys = ['query', 'sql', 'statement', 'q'];
    const key = sqlKeys.find((candidate) => typeof args[candidate] === 'string');

    if (!key) {
      // Schema/metadata tools (list_tables, describe_table) carry no statement.
      return { args };
    }

    const verdict = this.permissions.evaluateSql(args[key] as string, connector);
    if (verdict.effect !== 'allow') {
      return { refusal: verdict.reason };
    }

    const guarded: Record<string, unknown> = { ...args, [key]: verdict.sanitizedSql ?? args[key] };
    // Pass the row cap through when the downstream tool understands one.
    if (typeof args['limit'] === 'number' || args['limit'] === undefined) {
      const requested = typeof args['limit'] === 'number' ? args['limit'] : connector.maxRows;
      guarded['limit'] = Math.min(requested, connector.maxRows);
    }
    return { args: guarded };
  }

  async start(): Promise<void> {
    await this.refresh();
    this.started = true;
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('evidence broker listening on stdio');
  }

  async close(): Promise<void> {
    await this.manager.closeAll();
    try {
      await this.server.close();
    } catch {
      // Already closed.
    }
  }

  /** Test seam: populate the allowed set without a live downstream server. */
  setAllowedToolsForTesting(tools: readonly BrokeredTool[]): void {
    this.allowedTools = new Map(tools.map((tool) => [tool.exposedName, tool]));
    this.started = true;
  }
}

function buildDescription(tool: BrokeredTool): string {
  const parts: string[] = [];
  if (tool.normalizedCapability) parts.push(`[${tool.normalizedCapability}]`);
  parts.push(tool.description ?? `Read-only ${tool.connectorKind} evidence via "${tool.originalName}".`);
  parts.push(`(read-only; source: ${tool.connector})`);
  return parts.join(' ');
}

/** MCP requires an object schema; downstream servers occasionally omit it. */
function normalizeInputSchema(schema: unknown): { type: 'object'; [key: string]: unknown } {
  if (schema && typeof schema === 'object' && (schema as { type?: unknown }).type === 'object') {
    return schema as { type: 'object' };
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * Refusals carry a stable code as well as prose, so a reviewer that hits the
 * boundary can tell "not permitted" from "temporarily broken" and record the
 * right limitation instead of retrying forever.
 */
function refusal(code: ErrorCode, message: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: `[${code}] ${message}` }] };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ConnectorConfig } from '../config/config.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import type { Logger } from '../util/logger.js';

export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface DownstreamCallResult {
  isError: boolean;
  content: unknown;
  structuredContent?: unknown;
}

/**
 * Owns the lifecycle of connections to downstream MCP servers.
 *
 * Connections are lazy and per-connector: a review that never touches Jira
 * should not pay for starting the Jira server, and a broken connector must
 * degrade the review to a recorded limitation rather than fail it.
 */
export class DownstreamClientManager {
  private readonly clients = new Map<string, Client>();
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly connectors: readonly ConnectorConfig[],
    private readonly logger: Logger,
  ) {}

  getConnector(name: string): ConnectorConfig | undefined {
    return this.connectors.find((connector) => connector.name === name);
  }

  listConnectors(): readonly ConnectorConfig[] {
    return this.connectors;
  }

  /** Last connection error for a connector, if any. Used in limitations. */
  getFailure(name: string): string | undefined {
    return this.failures.get(name);
  }

  async connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;

    const pending = this.connecting.get(name);
    if (pending) return pending;

    const connector = this.getConnector(name);
    if (!connector) {
      throw new CodexMcpError(ErrorCodes.DOWNSTREAM_MCP_UNAVAILABLE, `Unknown connector "${name}".`);
    }
    if (!connector.enabled) {
      throw new CodexMcpError(ErrorCodes.DOWNSTREAM_MCP_PERMISSION_DENIED, `Connector "${name}" is disabled.`);
    }

    const promise = this.doConnect(connector)
      .then((client) => {
        this.clients.set(name, client);
        this.failures.delete(name);
        return client;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.failures.set(name, message);
        throw new CodexMcpError(
          ErrorCodes.DOWNSTREAM_MCP_UNAVAILABLE,
          `Connector "${name}" is unavailable: ${message}`,
          { cause: err },
        );
      })
      .finally(() => {
        this.connecting.delete(name);
      });

    this.connecting.set(name, promise);
    return promise;
  }

  private async doConnect(connector: ConnectorConfig): Promise<Client> {
    const client = new Client(
      { name: 'codex-mcp-broker', version: '1.0.0' },
      { capabilities: {} },
    );

    if (connector.transport === 'stdio') {
      if (!connector.command) {
        throw new Error('stdio connector has no `command`.');
      }
      const transport = new StdioClientTransport({
        command: connector.command,
        args: [...connector.args],
        // Pass only what the connector declares plus PATH/HOME: codex-mcp must
        // not hand a third-party process the whole environment.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...connector.env,
        },
        ...(connector.cwd ? { cwd: connector.cwd } : {}),
        stderr: 'pipe',
      });
      await withTimeout(client.connect(transport), connector.startupTimeoutMs, `connect to "${connector.name}"`);
    } else {
      if (!connector.url) {
        throw new Error('http connector has no `url`.');
      }
      const transport = new StreamableHTTPClientTransport(new URL(connector.url), {
        requestInit: { headers: { ...connector.headers } },
      });
      await withTimeout(client.connect(transport), connector.startupTimeoutMs, `connect to "${connector.name}"`);
    }

    this.logger.debug('downstream connector connected', { connector: connector.name, kind: connector.kind });
    return client;
  }

  async listTools(name: string): Promise<DownstreamTool[]> {
    const client = await this.connect(name);
    const connector = this.getConnector(name);
    const response = await withTimeout(
      client.listTools(),
      connector?.startupTimeoutMs ?? 30_000,
      `list tools for "${name}"`,
    );
    return (response.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<DownstreamCallResult> {
    const client = await this.connect(name);
    const connector = this.getConnector(name);
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      connector?.callTimeoutMs ?? 60_000,
      `call "${toolName}" on "${name}"`,
    );
    return {
      isError: Boolean(result.isError),
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  async closeAll(): Promise<void> {
    const closes = [...this.clients.entries()].map(async ([name, client]) => {
      try {
        await client.close();
      } catch (err) {
        this.logger.debug('error closing downstream connector', { connector: name, error: (err as Error).message });
      }
    });
    this.clients.clear();
    await Promise.allSettled(closes);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs}ms trying to ${label}.`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

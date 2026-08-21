import { resolve } from 'node:path';

import type { Config, ConnectorConfig } from '../config/config.js';
import { CodexMcpError } from '../errors/codex-mcp-error.js';
import { ErrorCodes } from '../errors/codes.js';
import { isInside, isReadableDirectory } from '../util/fs.js';
import { evaluateCommand, type CommandPolicyOptions } from './command-policy.js';
import { evaluateSqlStatement, type DbPolicyResult } from './db-policy.js';
import { evaluateMcpTool } from './mcp-policy.js';
import { deny, type PolicyDecision, type RiskClass } from './types.js';

/**
 * The single place every access decision is made, so the trust boundary can be
 * read in one file and asserted in one test suite (PLAN.md §7).
 *
 * Everything defaults to deny. Nothing here can be relaxed by a review request:
 * the caller supplies evidence and context, never permissions.
 */
export class PermissionEngine {
  constructor(private readonly config: Config) {}

  /** Codex must run under a non-mutating sandbox for the guarantee to hold. */
  get sandboxIsReadOnly(): boolean {
    return this.config.sandbox === 'read-only';
  }

  /** Validate a caller-supplied project root before anything reads from it. */
  async assertProjectRootReadable(root: string): Promise<string> {
    if (!this.config.permissions.projectRead) {
      throw new CodexMcpError(ErrorCodes.PROJECT_ACCESS_DENIED, 'Project read access is disabled by configuration.');
    }
    if (typeof root !== 'string' || root.trim() === '') {
      throw new CodexMcpError(ErrorCodes.INVALID_PROJECT_ROOT, '`project.root` is required.');
    }
    const resolved = resolve(root);
    if (!(await isReadableDirectory(resolved))) {
      throw new CodexMcpError(
        ErrorCodes.INVALID_PROJECT_ROOT,
        `\`project.root\` is not an existing readable directory: ${resolved}`,
      );
    }
    return resolved;
  }

  /**
   * Artifact paths come from the caller, so they are constrained to the project
   * root. Reading an arbitrary absolute path would turn the reviewer into a
   * file-exfiltration primitive for whoever can reach the MCP endpoint.
   */
  assertArtifactPathAllowed(projectRoot: string, artifactPath: string): string {
    const resolved = resolve(projectRoot, artifactPath);
    if (!isInside(projectRoot, resolved)) {
      throw new CodexMcpError(
        ErrorCodes.PROJECT_ACCESS_DENIED,
        'Artifact paths must be inside `project.root`.',
        { details: { projectRoot, artifactPath } },
      );
    }
    return resolved;
  }

  evaluateCommand(argv: readonly string[], options: CommandPolicyOptions = {}): PolicyDecision {
    return evaluateCommand(argv, { gitRead: this.config.permissions.gitRead, ...options });
  }

  evaluateSql(sql: string, connector?: ConnectorConfig): DbPolicyResult {
    return evaluateSqlStatement(sql, {
      maxRows: connector?.maxRows ?? 500,
      enforceRowLimit: true,
    });
  }

  evaluateDownstreamTool(connector: ConnectorConfig, toolName: string, risk: RiskClass): PolicyDecision {
    if (!connector.enabled) {
      return deny(risk, `Connector "${connector.name}" is disabled.`, 'connector.disabled');
    }
    return evaluateMcpTool(toolName, risk, {
      allowTools: connector.allowTools,
      denyTools: connector.denyTools,
      allowUnknown: this.config.permissions.allowUnknownDownstreamTools,
    });
  }

  /** Machine-readable summary of the boundary, used by `codex_capabilities`. */
  describe(): {
    project: { read: boolean; write: boolean };
    git: { read: boolean; write: boolean };
    sandbox: string;
    unknownDownstreamToolsAllowed: boolean;
  } {
    return {
      project: { read: this.config.permissions.projectRead, write: false },
      git: { read: this.config.permissions.gitRead, write: false },
      sandbox: this.config.sandbox,
      unknownDownstreamToolsAllowed: this.config.permissions.allowUnknownDownstreamTools,
    };
  }
}

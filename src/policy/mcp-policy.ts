import { allow, deny, type PolicyDecision, type RiskClass } from './types.js';

/**
 * Downstream MCP tool policy (PLAN.md §7.4).
 *
 *   read        -> allow
 *   write       -> deny
 *   destructive -> deny
 *   unknown     -> deny unless explicitly allowlisted
 *
 * The classifier that produces the risk class lives in
 * `mcp-broker/capability-classifier.ts`; this module only turns a class plus
 * per-connector allow/deny lists into a decision.
 */

export interface McpPolicyOptions {
  /** Tool names always permitted for this connector. */
  allowTools?: readonly string[];
  /** Tool names always refused, evaluated before everything else. */
  denyTools?: readonly string[];
  /** Global escape hatch; still cannot un-deny write/destructive tools. */
  allowUnknown?: boolean;
}

export function evaluateMcpTool(
  toolName: string,
  risk: RiskClass,
  options: McpPolicyOptions = {},
): PolicyDecision {
  const denyList = options.denyTools ?? [];
  const allowList = options.allowTools ?? [];

  if (matches(toolName, denyList)) {
    return deny(risk, `Tool "${toolName}" is on the connector deny list.`, 'mcp.deny-list');
  }

  // An allowlist may rescue an `unknown` tool, never a mutating one: a policy
  // that can be talked out of the write boundary is not a boundary.
  if (risk === 'destructive') {
    return deny('destructive', `Tool "${toolName}" is classified destructive and can never be exposed.`, 'mcp.destructive');
  }
  if (risk === 'write') {
    return deny('write', `Tool "${toolName}" is classified as mutating and is refused in read-only review.`, 'mcp.write');
  }

  if (risk === 'read') {
    return allow('read', `Tool "${toolName}" is classified read-only.`, 'mcp.read');
  }

  if (matches(toolName, allowList)) {
    return allow('unknown', `Tool "${toolName}" is unclassified but explicitly allowlisted.`, 'mcp.allow-list');
  }
  if (options.allowUnknown) {
    return allow('unknown', `Tool "${toolName}" is unclassified; allowed by \`allowUnknownDownstreamTools\`.`, 'mcp.allow-unknown');
  }
  return deny('unknown', `Tool "${toolName}" could not be classified as read-only and is refused by default.`, 'mcp.unknown');
}

/** Exact match, or a trailing `*` glob (`jira_get_*`). */
function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === name) return true;
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    return false;
  });
}

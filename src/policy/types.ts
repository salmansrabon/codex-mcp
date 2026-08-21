/** Risk classification shared by shell, SQL, and MCP-tool policy (PLAN.md §7.4). */
export type RiskClass = 'read' | 'write' | 'destructive' | 'unknown';

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyDecision {
  effect: PolicyEffect;
  risk: RiskClass;
  /** Human-readable justification; surfaced to Codex when a call is refused. */
  reason: string;
  /** Which rule produced the decision, for audit logs. */
  rule: string;
}

export function allow(risk: RiskClass, reason: string, rule: string): PolicyDecision {
  return { effect: 'allow', risk, reason, rule };
}

export function deny(risk: RiskClass, reason: string, rule: string): PolicyDecision {
  return { effect: 'deny', risk, reason, rule };
}

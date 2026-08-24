import type { Config } from '../config/config.js';

export interface BrokerLaunchSpec {
  /** MCP server name Codex will register the evidence broker under. */
  name: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
}

export interface BuildCodexArgsOptions {
  config: Config;
  projectRoot: string;
  /** Where Codex writes its final message. */
  lastMessageFile: string;
  /** Evidence broker to expose to Codex, if any connectors are usable. */
  broker?: BrokerLaunchSpec;
  /** Optional JSON Schema file constraining the final response. */
  outputSchemaFile?: string;
  /**
   * Per-review effort, chosen from the change set by `review-depth`.
   *
   * The configured value stays the ceiling — depth assessment only ever lowers
   * it — so an operator who pinned the reviewer to a high effort still gets it
   * on every change that carries risk.
   */
  reasoningEffort?: string;
}

/**
 * Build the `codex exec` argv (PLAN.md §20).
 *
 * Non-negotiable properties of every invocation:
 *   - non-interactive (`exec`, prompt on stdin);
 *   - sandboxed to the configured mode, which defaults to `read-only`;
 *   - rooted at the caller's project directory;
 *   - explicit about the model — never silently substituted;
 *   - ephemeral by default, so a review leaves no session state behind.
 */
export function buildCodexArgs(options: BuildCodexArgsOptions): string[] {
  const { config, projectRoot, lastMessageFile, broker, outputSchemaFile } = options;
  const reasoningEffort = options.reasoningEffort ?? config.reasoningEffort;

  const args: string[] = ['exec'];

  args.push('--sandbox', config.sandbox);
  args.push('-C', projectRoot);
  args.push('--skip-git-repo-check');
  args.push('--json');
  args.push('-o', lastMessageFile);
  args.push('--color', 'never');

  if (config.ephemeral) args.push('--ephemeral');
  if (config.model) args.push('-m', config.model);
  if (outputSchemaFile) args.push('--output-schema', outputSchemaFile);

  args.push('-c', `model_reasoning_effort=${tomlString(reasoningEffort)}`);

  // Approvals must never block a headless review; `never` makes Codex fail the
  // action instead of hanging on a prompt nobody can answer.
  args.push('-c', 'approval_policy="never"');

  if (broker) {
    const prefix = `mcp_servers.${broker.name}`;
    args.push('-c', `${prefix}.command=${tomlString(broker.command)}`);
    args.push('-c', `${prefix}.args=${tomlStringArray(broker.args)}`);
    if (broker.env && Object.keys(broker.env).length > 0) {
      args.push('-c', `${prefix}.env=${tomlInlineTable(broker.env)}`);
    }

    // Codex 0.149 gates every MCP tool call behind an approval, and
    // `approval_policy="never"` above turns that gate into a hard failure:
    // each brokered call comes back as "MCP tool call requires approval, but
    // approval policy is never", so the review silently loses all connector
    // evidence. Pre-approving this one server restores it. It does not widen
    // what Codex may call — the broker only ever advertises tools that
    // capability-classifier ruled `read` and mcp-policy allowed, so approval
    // here is a decision about a set codex-mcp already vetted.
    args.push('-c', `${prefix}.default_tools_approval_mode="approve"`);
  }

  // The prompt itself arrives on stdin; `-` makes that explicit.
  args.push('-');

  return args;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlInlineTable(record: Readonly<Record<string, string>>): string {
  const entries = Object.entries(record).map(([key, value]) => `${key}=${tomlString(value)}`);
  return `{${entries.join(',')}}`;
}

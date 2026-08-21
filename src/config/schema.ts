import { z } from 'zod';

/**
 * Schema for the optional `codex-mcp.yaml` file (PLAN.md §19).
 *
 * Every field is optional: an empty file must still produce a working,
 * read-only configuration. Defaults live in `config.ts` so environment
 * variables can be layered in between file and default.
 */

export const AuthModeSchema = z.enum(['chatgpt', 'api']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const SandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

/**
 * Reasoning levels Codex accepts. Which ones a given model supports varies —
 * `ultra` is frontier-only, for instance — so this is not narrowed per model:
 * Codex is the authority, and an unsupported level surfaces as a Codex error
 * rather than being silently downgraded here.
 */
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const TransportSchema = z.enum(['stdio', 'http']);

/** A downstream MCP server codex-mcp may broker (PLAN.md §8). */
export const ApprovalModeSchema = z.enum(['always', 'once', 'trusted']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ConnectorConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /**
     * Human approval before this connector is reached during a review.
     *   always  — ask every review
     *   once    — ask once per server session (default)
     *   trusted — never ask
     */
    approval: ApprovalModeSchema.optional(),
    /** Free-form kind hint used for normalization: jira, database, testrail, ftp, ... */
    kind: z.string().min(1).optional(),
    transport: TransportSchema.optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    /** Tool names always permitted, even if the classifier is unsure. */
    allowTools: z.array(z.string()).optional(),
    /** Tool names always refused, even if they classify as read. */
    denyTools: z.array(z.string()).optional(),
    startupTimeoutMs: z.number().int().positive().max(600_000).optional(),
    callTimeoutMs: z.number().int().positive().max(600_000).optional(),
    /** Database-specific limits; ignored for non-database connectors. */
    maxRows: z.number().int().positive().max(100_000).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();
export type ConnectorConfigInput = z.infer<typeof ConnectorConfigSchema>;

export const FileConfigSchema = z
  .object({
    review: z
      .object({
        maxPasses: z.number().int().min(1).max(10).optional(),
        sandbox: SandboxModeSchema.optional(),
        model: z.string().min(1).optional(),
        /** Refuse to review with no pinned model, instead of using the Codex default. */
        requireModel: z.boolean().optional(),
        reasoningEffort: ReasoningEffortSchema.optional(),
        ephemeral: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
        maxConcurrentReviews: z.number().int().min(1).max(32).optional(),
        maxArtifactBytes: z.number().int().positive().max(10_000_000).optional(),
        maxCandidateItems: z.number().int().positive().max(2000).optional(),
      })
      .strict()
      .optional(),

    auth: z
      .object({
        mode: AuthModeSchema.optional(),
        codexBinary: z.string().min(1).optional(),
      })
      .strict()
      .optional(),

    permissions: z
      .object({
        project: z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).strict().optional(),
        git: z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).strict().optional(),
        /** Unknown downstream tools stay denied unless explicitly allowlisted. */
        allowUnknownDownstreamTools: z.boolean().optional(),
      })
      .strict()
      .optional(),

    connectors: z.record(ConnectorConfigSchema).optional(),

    memory: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    logging: z
      .object({
        level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

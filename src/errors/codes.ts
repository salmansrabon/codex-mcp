/**
 * Stable, machine-readable error codes (PLAN.md §22).
 *
 * These are part of the public contract: callers may branch on them, so values
 * must not change once released. Error payloads carrying these codes must never
 * contain secrets.
 */
export const ErrorCodes = {
  CODEX_AUTH_REQUIRED: 'CODEX_AUTH_REQUIRED',
  CODEX_NOT_INSTALLED: 'CODEX_NOT_INSTALLED',
  CODEX_MODEL_NOT_CONFIGURED: 'CODEX_MODEL_NOT_CONFIGURED',
  CODEX_MODEL_NOT_AVAILABLE: 'CODEX_MODEL_NOT_AVAILABLE',

  INVALID_PROJECT_ROOT: 'INVALID_PROJECT_ROOT',
  PROJECT_ACCESS_DENIED: 'PROJECT_ACCESS_DENIED',

  INVALID_REVIEW_REQUEST: 'INVALID_REVIEW_REQUEST',
  INVALID_REVIEW_TYPE: 'INVALID_REVIEW_TYPE',

  DOWNSTREAM_MCP_UNAVAILABLE: 'DOWNSTREAM_MCP_UNAVAILABLE',
  DOWNSTREAM_MCP_PERMISSION_DENIED: 'DOWNSTREAM_MCP_PERMISSION_DENIED',

  DB_QUERY_DENIED: 'DB_QUERY_DENIED',
  DB_QUERY_TIMEOUT: 'DB_QUERY_TIMEOUT',

  CODEX_EXECUTION_FAILED: 'CODEX_EXECUTION_FAILED',
  CODEX_OUTPUT_INVALID: 'CODEX_OUTPUT_INVALID',

  REVIEW_TIMEOUT: 'REVIEW_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCodes);

/** Human-facing remediation hints, kept separate from the code itself. */
export const ERROR_REMEDIATION: Partial<Record<ErrorCode, string>> = {
  CODEX_AUTH_REQUIRED: 'Run `codex-mcp login`.',
  CODEX_NOT_INSTALLED: 'Install the Codex CLI and make sure `codex` is on PATH.',
  CODEX_MODEL_NOT_CONFIGURED: 'Set CODEX_MODEL in the environment or `review.model` in codex-mcp.yaml.',
  CODEX_MODEL_NOT_AVAILABLE: 'Pick a model your Codex account can use, or clear CODEX_MODEL to use the Codex default.',
  INVALID_PROJECT_ROOT: 'Pass an absolute path to an existing, readable directory as `project.root`.',
  DOWNSTREAM_MCP_UNAVAILABLE: 'Check the connector command/URL in codex-mcp.yaml and that the downstream server starts.',
};

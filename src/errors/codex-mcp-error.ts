import { ERROR_REMEDIATION, ErrorCodes, type ErrorCode } from './codes.js';
import { redactValue } from '../util/redact.js';

export interface CodexMcpErrorOptions {
  /** Structured, non-sensitive detail. Redacted before it leaves the process. */
  details?: unknown;
  cause?: unknown;
  /** Set false for programmer errors that should not be shown verbatim to callers. */
  retryable?: boolean;
}

/**
 * The single error type crossing the MCP boundary. Every throw site inside
 * codex-mcp should either raise this or be wrapped by {@link toCodexMcpError}.
 */
export class CodexMcpError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: CodexMcpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodexMcpError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  get remediation(): string | undefined {
    return ERROR_REMEDIATION[this.code];
  }

  /** Redacted, serializable payload. Safe to return to an MCP client or log. */
  toPayload(): {
    code: ErrorCode;
    message: string;
    remediation?: string;
    details?: unknown;
  } {
    const payload: { code: ErrorCode; message: string; remediation?: string; details?: unknown } = {
      code: this.code,
      message: redactValue(this.message) as string,
    };
    if (this.remediation) payload.remediation = this.remediation;
    if (this.details !== undefined) payload.details = redactValue(this.details);
    return payload;
  }
}

/** Normalize any thrown value into a CodexMcpError without leaking stack detail. */
export function toCodexMcpError(err: unknown, fallbackCode: ErrorCode = ErrorCodes.INTERNAL_ERROR): CodexMcpError {
  if (err instanceof CodexMcpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CodexMcpError(fallbackCode, message, { cause: err });
}

import { describe, expect, it } from 'vitest';

import { ALL_ERROR_CODES, ErrorCodes } from '../../src/errors/codes.js';
import { CodexMcpError, toCodexMcpError } from '../../src/errors/codex-mcp-error.js';

describe('error codes', () => {
  it('defines every code the plan specifies', () => {
    const required = [
      'CODEX_AUTH_REQUIRED',
      'CODEX_NOT_INSTALLED',
      'CODEX_MODEL_NOT_CONFIGURED',
      'CODEX_MODEL_NOT_AVAILABLE',
      'INVALID_PROJECT_ROOT',
      'PROJECT_ACCESS_DENIED',
      'INVALID_REVIEW_REQUEST',
      'INVALID_REVIEW_TYPE',
      'DOWNSTREAM_MCP_UNAVAILABLE',
      'DOWNSTREAM_MCP_PERMISSION_DENIED',
      'DB_QUERY_DENIED',
      'DB_QUERY_TIMEOUT',
      'CODEX_EXECUTION_FAILED',
      'CODEX_OUTPUT_INVALID',
      'REVIEW_TIMEOUT',
      'INTERNAL_ERROR',
    ];
    expect([...ALL_ERROR_CODES].sort()).toEqual(required.sort());
  });

  it('uses each code name as its own value, so the wire format is stable', () => {
    for (const [key, value] of Object.entries(ErrorCodes)) expect(value).toBe(key);
  });
});

describe('CodexMcpError', () => {
  it('carries a code and attaches remediation where one exists', () => {
    const error = new CodexMcpError(ErrorCodes.CODEX_AUTH_REQUIRED, 'not authenticated');
    expect(error.toPayload()).toMatchObject({
      code: 'CODEX_AUTH_REQUIRED',
      message: 'not authenticated',
      remediation: 'Run `codex-mcp login`.',
    });
  });

  it('redacts secrets from the message', () => {
    const error = new CodexMcpError(ErrorCodes.INTERNAL_ERROR, 'failed with token=sk-abcdefghijklmnopqrst');
    expect(error.toPayload().message).not.toContain('sk-abcdefghijklmnopqrst');
  });

  it('redacts secrets from structured details', () => {
    const error = new CodexMcpError(ErrorCodes.DOWNSTREAM_MCP_UNAVAILABLE, 'nope', {
      details: { connector: 'jira', env: { JIRA_API_TOKEN: 'super-secret' } },
    });
    expect(JSON.stringify(error.toPayload())).not.toContain('super-secret');
  });

  it('omits details entirely when there are none', () => {
    expect(new CodexMcpError(ErrorCodes.INTERNAL_ERROR, 'x').toPayload()).not.toHaveProperty('details');
  });
});

describe('toCodexMcpError', () => {
  it('passes an existing CodexMcpError through unchanged', () => {
    const original = new CodexMcpError(ErrorCodes.REVIEW_TIMEOUT, 'slow');
    expect(toCodexMcpError(original)).toBe(original);
  });

  it('wraps a plain Error as INTERNAL_ERROR by default', () => {
    expect(toCodexMcpError(new Error('boom')).code).toBe('INTERNAL_ERROR');
  });

  it('honors an explicit fallback code', () => {
    expect(toCodexMcpError('boom', ErrorCodes.CODEX_EXECUTION_FAILED).code).toBe('CODEX_EXECUTION_FAILED');
  });

  it('stringifies non-Error throws', () => {
    expect(toCodexMcpError({ weird: true }).message).toBe('[object Object]');
  });
});

/**
 * Secret redaction (PLAN.md §23). Applied to everything that leaves the process
 * as a log line or an error payload.
 *
 * Two layers: key-name matching for structured data, and pattern matching for
 * free text. Neither is perfect; both are cheap and catch the common cases.
 */

const REDACTED = '[REDACTED]';

/** Object keys whose values are always replaced, regardless of content. */
// `pass` alone is deliberately absent: it is a common non-secret field name
// (a review pass number, a pass/fail count) and matching it redacts data the
// operator needs. Only the actual credential spellings are matched.
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|passphrase|secret|token|api[-_]?key|apikey|auth|authorization|credential|cookie|session|private[-_]?key|connection[-_]?string|dsn|bearer|refresh)/i;

/**
 * Keys that trip the pattern above but carry no secret — auth *state* rather
 * than an auth credential, and token *counts* rather than a token.
 *
 * Enumerated deliberately rather than inferred (for example by exempting
 * numeric values): an allowlist you can reason about beats a heuristic that
 * quietly widens as data shapes change.
 */
const SENSITIVE_KEY_ALLOWLIST = new Set([
  'authMode',
  'authenticated',
  'authRequired',
  'authStatus',
  'configuredAuthMode',
  'modeMatchesConfiguration',
  'tokenBudget',
  'tokens',
  'tokenUsage',
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
]);

interface TextPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const TEXT_PATTERNS: readonly TextPattern[] = [
  // OpenAI-style and generic long API keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  { pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  // JWTs.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: REDACTED },
  // Authorization headers.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  // key=value / key: value pairs in free text.
  {
    pattern:
      /\b(pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key)\b(\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi,
    replacement: `$1$2$3${REDACTED}$3`,
  },
  // Credentials embedded in URLs.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replacement: `$1$2:${REDACTED}@` },
];

/** Redact secrets from a string. */
export function redactText(input: string): string {
  let out = input;
  for (const { pattern, replacement } of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** True when a key name should have its value replaced wholesale. */
export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_ALLOWLIST.has(key)) return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Deep-redact an arbitrary value. Cycles are broken, and depth is bounded so a
 * pathological payload cannot hang the logger.
 */
export function redactValue(value: unknown, maxDepth = 12): unknown {
  return redactInner(value, maxDepth, new WeakSet());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth <= 0) return '[TRUNCATED]';

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => redactInner(item, depth - 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactInner(item, depth - 1, seen);
    }
    return out;
  }
  return String(value);
}

/** Stable, non-reversible identifier for a filesystem path (PLAN.md §23). */
export async function safePathIdentifier(absolutePath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

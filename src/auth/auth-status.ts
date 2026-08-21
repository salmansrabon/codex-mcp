import type { AuthMode } from '../config/schema.js';

export interface AuthStatus {
  authenticated: boolean;
  /** Mode Codex reports it is actually using, when it can be determined. */
  authMode: AuthMode | 'unknown';
  /** Non-sensitive account hint, e.g. a plan name. Never a token. */
  accountHint?: string;
  /** Raw CLI text, redacted, kept only for `doctor` diagnostics. */
  detail?: string;
}

/**
 * Parse `codex login status` output.
 *
 * The CLI's wording varies across versions, so this matches on intent rather
 * than an exact string, and defaults to "not authenticated" when unsure —
 * a false negative costs the user one login; a false positive produces a
 * confusing mid-review failure.
 */
export function parseAuthStatus(stdout: string, stderr: string, exitCode: number | null): AuthStatus {
  const text = `${stdout}\n${stderr}`.trim();
  const lower = text.toLowerCase();

  const notLoggedIn =
    /\bnot\s+logged\s*in\b/.test(lower) ||
    /\bnot\s+authenticated\b/.test(lower) ||
    /\bno\s+(stored\s+)?credentials\b/.test(lower) ||
    /\bplease\s+(run\s+)?`?codex login`?\b/.test(lower) ||
    /\brun\s+`?codex login`?\b/.test(lower);

  const loggedIn = !notLoggedIn && /\b(logged\s*in|authenticated|signed\s*in)\b/.test(lower);

  let authMode: AuthMode | 'unknown' = 'unknown';
  if (/\bapi\s*key\b/.test(lower)) authMode = 'api';
  else if (/\bchatgpt\b/.test(lower) || /\bsubscription\b/.test(lower)) authMode = 'chatgpt';

  const authenticated = exitCode === 0 && loggedIn;

  const status: AuthStatus = {
    authenticated,
    authMode: authenticated ? authMode : 'unknown',
  };

  const planMatch = /\b(plan|account)\b[:\s]+([A-Za-z0-9 _-]{1,40})/i.exec(text);
  if (planMatch?.[2]) status.accountHint = planMatch[2].trim();
  if (text) status.detail = text;

  return status;
}

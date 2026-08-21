import type { AuthManager } from '../auth/auth-manager.js';

export const CODEX_AUTH_STATUS_TOOL_NAME = 'codex_auth_status';

export const CODEX_AUTH_STATUS_DESCRIPTION = `Report whether Codex is authenticated and which auth mode is in use.

Call this before a review if you want to fail fast with a clear message. Credentials are owned by
the Codex CLI and the operating system; this never returns a token, API key, cookie, or any other
secret.

Two auth modes are supported: \`chatgpt\` (browser sign-in to a ChatGPT subscription) and \`api\`
(an OpenAI API key). The response reports the active mode, the configured mode, and whether they
agree — reviews fail while they disagree.

If it reports \`authenticated: false\`, the user must run \`codex-mcp login\` in a terminal. That
flow is interactive and cannot be triggered from here.`;

export const CODEX_AUTH_STATUS_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export async function handleCodexAuthStatus(authManager: AuthManager): Promise<unknown> {
  const status = await authManager.publicStatus();
  const loginCommand = status.configuredAuthMode === 'api' ? 'codex-mcp login --mode api' : 'codex-mcp login';

  if (!status.authenticated) {
    return { ...status, remediation: `Run \`${loginCommand}\` in a terminal.` };
  }
  if (!status.modeMatchesConfiguration) {
    return {
      ...status,
      remediation:
        `Codex is authenticated with "${status.authMode}" but AUTH_MODE is "${status.configuredAuthMode}". ` +
        `Run \`${loginCommand}\` to switch, or change AUTH_MODE to match. Reviews will fail until they agree.`,
    };
  }
  return status;
}

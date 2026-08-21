import { describe, expect, it } from 'vitest';

import { isSensitiveKey, redactText, redactValue } from '../../src/util/redact.js';

describe('redactText', () => {
  it('redacts API-key-shaped tokens', () => {
    expect(redactText('key is sk-abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactText(`Authorization token ${jwt}`)).not.toContain(jwt);
  });

  it('redacts bearer headers', () => {
    expect(redactText('Authorization: Bearer abc123def456ghi')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts key=value secrets in free text', () => {
    expect(redactText('password=hunter2 and token: abc123xyz')).toBe('password=[REDACTED] and token: [REDACTED]');
  });

  it('redacts credentials embedded in URLs', () => {
    expect(redactText('postgres://user:s3cret@db.example.com/app')).toBe('postgres://user:[REDACTED]@db.example.com/app');
  });

  it('leaves ordinary text alone', () => {
    const text = 'src/session/service.ts:143 expects the queue to remain persisted';
    expect(redactText(text)).toBe(text);
  });
});

describe('isSensitiveKey', () => {
  it.each(['password', 'apiKey', 'API_KEY', 'accessToken', 'refresh_token', 'cookie', 'connectionString'])(
    'treats %s as sensitive',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each(['authMode', 'authenticated', 'reviewId', 'model'])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactValue', () => {
  it('replaces sensitive values by key name', () => {
    expect(redactValue({ user: 'qa', password: 'hunter2' })).toEqual({ user: 'qa', password: '[REDACTED]' });
  });

  it('recurses into arrays and nested objects', () => {
    const input = { connectors: [{ name: 'jira', env: { JIRA_API_TOKEN: 'abc' } }] };
    expect(redactValue(input)).toEqual({ connectors: [{ name: 'jira', env: { JIRA_API_TOKEN: '[REDACTED]' } }] });
  });

  it('breaks cycles instead of hanging', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(redactValue(cyclic)).toEqual({ name: 'x', self: '[CIRCULAR]' });
  });

  it('truncates beyond max depth', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('TRUNCATED');
  });

  it('preserves the auth-mode discriminator so status output stays useful', () => {
    expect(redactValue({ authenticated: true, authMode: 'chatgpt' })).toEqual({ authenticated: true, authMode: 'chatgpt' });
  });
});

describe('non-secret keys that merely look sensitive', () => {
  it('does not redact a review pass number', () => {
    // Regression: `pass(word|wd)?` matched a bare `pass`, redacting the review
    // pass counter out of every log line.
    expect(redactValue({ pass: 2, maxPasses: 2 })).toEqual({ pass: 2, maxPasses: 2 });
    expect(isSensitiveKey('pass')).toBe(false);
    expect(isSensitiveKey('maxPasses')).toBe(false);
  });

  it('does not redact token counts', () => {
    // Regression: /token/i matched `tokens`, `inputTokens`, and friends, so the
    // usage accounting logged as "[REDACTED]".
    expect(
      redactValue({ tokens: { inputTokens: 31062, outputTokens: 76, cachedInputTokens: 25088 } }),
    ).toEqual({ tokens: { inputTokens: 31062, outputTokens: 76, cachedInputTokens: 25088 } });
  });

  it('does not redact auth state, only auth credentials', () => {
    expect(redactValue({ authMode: 'api', configuredAuthMode: 'api', modeMatchesConfiguration: true })).toEqual({
      authMode: 'api',
      configuredAuthMode: 'api',
      modeMatchesConfiguration: true,
    });
  });

  it('still redacts the real credential spellings', () => {
    for (const key of ['password', 'passwd', 'passphrase']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('still redacts an actual token value next to the counts', () => {
    const out = redactValue({ tokens: { inputTokens: 10 }, accessToken: 'sk-abcdefghijklmnopqrst' }) as Record<string, unknown>;
    expect(out['accessToken']).toBe('[REDACTED]');
    expect(out['tokens']).toEqual({ inputTokens: 10 });
  });
});

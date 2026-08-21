import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A fixture built for the live-Codex scenarios, not for unit tests.
 *
 * The requirement is deliberately simple — *"an account locks after 5
 * consecutive failed login attempts"* — because the interesting question is not
 * whether Codex can read hard code. It is whether Codex, given a plausible
 * candidate set, independently derives the coverage the set is missing and
 * independently finds a defect nobody reported.
 *
 * Two things are planted:
 *
 * 1. **Coverage gaps.** The candidate set covers success, wrong password, and
 *    lockout-at-5. It omits the 4-vs-5 boundary and the behavior of a *correct*
 *    password once the account is already locked.
 *
 * 2. **A real, unreported defect.** `login()` never clears `failedAttempts` on
 *    success, so four failures followed by a success followed by one more
 *    failure locks the account — which violates the word *consecutive* in the
 *    requirement. It is reachable, evidenced in one file, and nothing in the
 *    candidate bug set mentions it.
 *
 * Both are things a careful reviewer finds by reading the code against the
 * requirement, and neither is findable by paraphrasing the candidate.
 */

export interface LockoutFixture {
  root: string;
  configDir: string;
}

const LOGIN_SERVICE = `import { verifyPassword } from './password.js';

export const MAX_FAILED_ATTEMPTS = 5;

/**
 * Authenticate a user.
 *
 * Locking is driven by the account's failedAttempts counter, which
 * recordFailure() increments on every rejected password.
 */
export async function login(store, username, password) {
  const account = await store.findByUsername(username);
  if (!account) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (account.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: 'locked' };
  }

  if (!verifyPassword(account, password)) {
    await store.recordFailure(account.id, account.failedAttempts + 1);
    const nowLocked = account.failedAttempts + 1 >= MAX_FAILED_ATTEMPTS;
    return { ok: false, reason: nowLocked ? 'locked' : 'invalid_credentials' };
  }

  await store.touchLastLogin(account.id);
  return { ok: true, accountId: account.id };
}
`;

const ACCOUNT_STORE = `/**
 * Persistence for accounts. failedAttempts is the only lockout state; there is
 * no separate lockedAt column and no scheduled unlock.
 */
export function createAccountStore(db) {
  return {
    async findByUsername(username) {
      return db.accounts.find((account) => account.username === username) ?? null;
    },

    async recordFailure(accountId, attempts) {
      const account = db.accounts.find((entry) => entry.id === accountId);
      if (account) account.failedAttempts = attempts;
    },

    async clearFailures(accountId) {
      const account = db.accounts.find((entry) => entry.id === accountId);
      if (account) account.failedAttempts = 0;
    },

    async touchLastLogin(accountId) {
      const account = db.accounts.find((entry) => entry.id === accountId);
      if (account) account.lastLoginAt = new Date().toISOString();
    },
  };
}
`;

const ROUTES = `import { login } from '../auth/login-service.js';

export function registerAuthRoutes(router, store) {
  router.post('/session', async (req, res) => {
    const result = await login(store, req.body.username, req.body.password);
    if (result.ok) return res.status(200).json({ accountId: result.accountId });
    if (result.reason === 'locked') return res.status(423).json({ error: 'account_locked' });
    return res.status(401).json({ error: 'invalid_credentials' });
  });
}
`;

const PASSWORD = `import { createHash } from 'node:crypto';

export function verifyPassword(account, password) {
  return createHash('sha256').update(password).digest('hex') === account.passwordHash;
}
`;

const EXISTING_TEST = `import { describe, it, expect } from 'vitest';
import { login } from '../src/auth/login-service.js';

function storeFor(account) {
  return {
    findByUsername: async () => account,
    recordFailure: async (_id, attempts) => { account.failedAttempts = attempts; },
    clearFailures: async () => { account.failedAttempts = 0; },
    touchLastLogin: async () => {},
  };
}

describe('login', () => {
  it('rejects a wrong password', async () => {
    const account = { id: 'a1', username: 'ada', passwordHash: 'nope', failedAttempts: 0 };
    const result = await login(storeFor(account), 'ada', 'wrong');
    expect(result.ok).toBe(false);
  });
});
`;

const REQUIREMENT = `# SEC-401 — Lock an account after repeated failed logins

An account becomes locked after 5 consecutive failed login attempts.

## Acceptance criteria

1. A successful login with the correct password returns the account id.
2. A login with an incorrect password is rejected.
3. After 5 consecutive failed attempts the account is locked and further login
   attempts are refused.
4. A successful login resets the consecutive-failure count, so failures that are
   not consecutive never accumulate to a lock.
5. Once locked, the account stays locked even when the correct password is
   supplied.
`;

export function createLockoutFixture(): LockoutFixture {
  const base = mkdtempSync(join(tmpdir(), 'codex-mcp-lockout-'));
  const root = join(base, 'project');

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'lockout-app', version: '1.0.0', private: true }, null, 2),
    'docs/SEC-401.md': REQUIREMENT,
    'src/auth/login-service.js': LOGIN_SERVICE,
    'src/auth/password.js': PASSWORD,
    'src/auth/account-store.js': ACCOUNT_STORE,
    'src/routes/session.js': ROUTES,
    'tests/login.test.js': EXISTING_TEST,
  };

  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' },
    });
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'SEC-401: lock an account after repeated failed logins');

  return { root, configDir: base };
}

/**
 * Plausible but incomplete. Covers the three obvious cases and omits the two
 * that require reading AC-4 and AC-5 against the implementation.
 */
export const LOCKOUT_TEST_CASES = [
  {
    id: 'TC-1',
    title: 'A user logs in successfully with the correct password',
    priority: 'high',
    expectedResult: 'The response contains the account id.',
  },
  {
    id: 'TC-2',
    title: 'A login with an incorrect password is rejected',
    priority: 'high',
    expectedResult: 'The response is 401 invalid_credentials.',
  },
  {
    id: 'TC-3',
    title: 'The account locks after 5 consecutive failed attempts',
    priority: 'high',
    expectedResult: 'The sixth attempt returns 423 account_locked.',
  },
];

/**
 * One low-value candidate that says nothing about the planted defect, so
 * `additionalFindings` is the only place the reviewer can report it.
 */
export const LOCKOUT_CANDIDATE_BUGS = [
  {
    id: 'BUG-1',
    title: 'A locked account returns 423 rather than 401',
    severity: 'low',
    stepsToReproduce: ['Fail 5 times', 'Attempt a sixth login'],
    expectedBehavior: 'The API returns 401 to avoid revealing that the account exists',
    actualBehavior: 'The API returns 423 account_locked',
  },
];

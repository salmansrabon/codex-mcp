import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectMemoryStore,
  projectMemoryId,
  renderProjectMemory,
  screenFacts,
} from '../../src/memory/project-memory.js';
import type { MemoryFact } from '../../src/schemas/review-common.js';
import { Logger } from '../../src/util/logger.js';

let dir: string;
const silent = new Logger('error', {}, { write: () => {} });

function store(enabled = true): ProjectMemoryStore {
  return new ProjectMemoryStore({ stateDir: dir, logger: silent, enabled });
}

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    topic: 'tenant ownership',
    fact: 'Ownership is enforced in router middleware before the service runs.',
    evidence: [{ source: 'code', location: 'src/middleware/access.ts:6' }],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-mcp-memory-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('screenFacts', () => {
  it('refuses a fact with no evidence', () => {
    const { accepted, rejected } = screenFacts([fact({ evidence: [] })]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.why).toMatch(/no evidence/);
  });

  it('refuses anything that looks like a credential', () => {
    // A reviewer can read a .env; what it must not do is help us cache it.
    const { accepted, rejected } = screenFacts([
      fact({ topic: 'db access', fact: 'The service connects with password hunter2.' }),
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.why).toMatch(/credential|secret/);
  });

  it('refuses hedged wording, which is not settled knowledge', () => {
    const { accepted } = screenFacts([fact({ fact: 'Ownership might be enforced in middleware.' })]);
    expect(accepted).toHaveLength(0);
  });

  it('accepts a verified, evidenced, unhedged fact', () => {
    expect(screenFacts([fact()]).accepted).toHaveLength(1);
  });
});

describe('ProjectMemoryStore', () => {
  it('round-trips a fact for the same project', async () => {
    const s = store();
    await s.persist('/repo/alpha', [fact()]);
    const recalled = await s.retrieve('/repo/alpha');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.status).toBe('verified');
    expect(recalled[0]?.confirmations).toBe(1);
  });

  it('keeps projects separate', async () => {
    const s = store();
    await s.persist('/repo/alpha', [fact()]);
    expect(await s.retrieve('/repo/beta')).toHaveLength(0);
  });

  it('counts confirmations instead of duplicating a repeated fact', async () => {
    const s = store();
    await s.persist('/repo/alpha', [fact()]);
    await s.persist('/repo/alpha', [fact()]);
    const recalled = await s.retrieve('/repo/alpha');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.confirmations).toBe(2);
  });

  it('stores nothing when memory is disabled', async () => {
    const s = store(false);
    await s.persist('/repo/alpha', [fact()]);
    expect(await s.retrieve('/repo/alpha')).toHaveLength(0);
  });

  it('returns empty rather than throwing when the store is unreadable', async () => {
    const s = new ProjectMemoryStore({ stateDir: '/nonexistent/nope', logger: silent, enabled: true });
    expect(await s.retrieve('/repo/alpha')).toEqual([]);
  });

  it('does not fail a review when the store cannot be written', async () => {
    // A regular file where a directory belongs: mkdir fails with ENOTDIR, which
    // is the realistic shape of a broken state dir and fails fast.
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const s = new ProjectMemoryStore({ stateDir: blocked, logger: silent, enabled: true });
    await expect(s.persist('/repo/alpha', [fact()])).resolves.toBeDefined();
    expect(await s.retrieve('/repo/alpha')).toEqual([]);
  });

  it('derives a project id that matches the hash used for provenance', () => {
    expect(projectMemoryId('/repo/alpha')).toMatch(/^[0-9a-f]{12}$/);
    expect(projectMemoryId('/repo/alpha')).toBe(projectMemoryId('/repo/alpha'));
    expect(projectMemoryId('/repo/alpha')).not.toBe(projectMemoryId('/repo/beta'));
  });
});

describe('renderProjectMemory', () => {
  it('renders nothing when there is nothing remembered', () => {
    expect(renderProjectMemory([])).toBe('');
  });

  it('tells the reviewer the code outranks a remembered fact', async () => {
    const s = store();
    await s.persist('/repo/alpha', [fact({ implication: 'Controller-level tests cannot reach it.' })]);
    const rendered = renderProjectMemory(await s.retrieve('/repo/alpha'));
    expect(rendered).toContain('tenant ownership');
    expect(rendered).toContain('Implication: Controller-level tests cannot reach it.');
    expect(rendered).toContain('src/middleware/access.ts:6');
    expect(rendered).toMatch(/code now contradicts one, the code wins/);
  });
});

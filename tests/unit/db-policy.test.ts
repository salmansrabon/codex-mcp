import { describe, expect, it } from 'vitest';

import { evaluateSqlStatement, splitStatements, stripSqlNoise } from '../../src/policy/db-policy.js';

const verdict = (sql: string, maxRows = 500) => evaluateSqlStatement(sql, { maxRows });

describe('stripSqlNoise', () => {
  it('removes line, hash, and block comments', () => {
    expect(stripSqlNoise('SELECT 1 -- DELETE FROM t').toLowerCase()).not.toContain('delete');
    expect(stripSqlNoise('SELECT 1 /* DROP TABLE t */').toLowerCase()).not.toContain('drop');
  });

  it('replaces string literals so keywords inside them cannot trip the filter', () => {
    const stripped = stripSqlNoise("SELECT * FROM t WHERE note = 'please delete this'");
    expect(stripped.toLowerCase()).not.toContain('delete');
  });

  it('handles escaped and doubled quotes', () => {
    expect(() => stripSqlNoise("SELECT 'it''s fine', 'a\\'b'")).not.toThrow();
  });
});

describe('splitStatements', () => {
  it('detects multiple statements', () => {
    expect(splitStatements(stripSqlNoise('SELECT 1; DELETE FROM users'))).toHaveLength(2);
  });

  it('ignores a single trailing semicolon', () => {
    expect(splitStatements(stripSqlNoise('SELECT 1;'))).toHaveLength(1);
  });
});

describe('allowed statements', () => {
  it.each([
    'SELECT id FROM users WHERE tenant_id = 1',
    'select * from orders',
    'SHOW TABLES',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT * FROM users',
    'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
  ])('allows %s', (sql) => {
    expect(verdict(sql).effect).toBe('allow');
  });

  it('appends a row limit when the statement has none', () => {
    expect(verdict('SELECT * FROM users', 100).sanitizedSql).toBe('SELECT * FROM users LIMIT 100');
  });

  it('leaves an existing limit alone', () => {
    expect(verdict('SELECT * FROM users LIMIT 5').sanitizedSql).toBe('SELECT * FROM users LIMIT 5');
  });

  it('does not add a limit to SHOW or DESCRIBE', () => {
    expect(verdict('SHOW TABLES').sanitizedSql).toBe('SHOW TABLES');
    expect(verdict('DESCRIBE users').sanitizedSql).toBe('DESCRIBE users');
  });

  it('strips a trailing semicolon before appending a limit', () => {
    expect(verdict('SELECT 1;', 10).sanitizedSql).toBe('SELECT 1 LIMIT 10');
  });
});

describe('refused statements', () => {
  it.each([
    ['INSERT INTO users (id) VALUES (1)', 'write'],
    ['UPDATE users SET name = \'x\'', 'write'],
    ['DELETE FROM users', 'write'],
    ['DROP TABLE users', 'destructive'],
    ['ALTER TABLE users ADD COLUMN x INT', 'destructive'],
    ['TRUNCATE TABLE users', 'destructive'],
  ])('refuses %s', (sql, risk) => {
    const result = verdict(sql);
    expect(result.effect).toBe('deny');
    expect(result.risk).toBe(risk);
  });

  it('refuses multi-statement payloads', () => {
    const result = verdict('SELECT 1; DROP TABLE users');
    expect(result.effect).toBe('deny');
    expect(result.reason).toMatch(/one statement/);
  });

  it('refuses a mutation hidden after a comment', () => {
    expect(verdict('SELECT 1 /* x */; DELETE FROM users').effect).toBe('deny');
  });

  it('refuses stored procedure invocation', () => {
    expect(verdict('CALL purge_old_rows()').effect).toBe('deny');
    expect(verdict('EXEC sp_delete_users').effect).toBe('deny');
  });

  it('refuses EXPLAIN ANALYZE because it executes the plan', () => {
    expect(verdict('EXPLAIN ANALYZE SELECT * FROM users').effect).toBe('deny');
    expect(verdict('EXPLAIN SELECT * FROM users').effect).toBe('allow');
  });

  it('refuses side-effecting functions inside a SELECT', () => {
    expect(verdict('SELECT pg_sleep(10)').effect).toBe('deny');
    expect(verdict('SELECT load_file(\'/etc/passwd\')').effect).toBe('deny');
    expect(verdict('SELECT nextval(\'seq\')').effect).toBe('deny');
  });

  it('refuses SELECT ... INTO OUTFILE', () => {
    expect(verdict("SELECT * FROM users INTO OUTFILE '/tmp/x'").effect).toBe('deny');
  });

  it('refuses row locking and RETURNING', () => {
    expect(verdict('SELECT * FROM users FOR UPDATE').effect).toBe('deny');
    expect(verdict('SELECT * FROM users RETURNING id').effect).toBe('deny');
  });

  it('refuses transaction and session control', () => {
    expect(verdict('BEGIN').effect).toBe('deny');
    expect(verdict('COMMIT').effect).toBe('deny');
    expect(verdict('SET search_path = evil').effect).toBe('deny');
  });

  it('refuses an empty statement', () => {
    expect(verdict('   ').effect).toBe('deny');
  });

  it('does not flag column names that merely contain keywords', () => {
    expect(verdict('SELECT created_at, updated_at, deleted_flag FROM users').effect).toBe('allow');
  });

  it('always reports the row cap, even when refusing', () => {
    expect(verdict('DELETE FROM users', 42).maxRows).toBe(42);
  });
});

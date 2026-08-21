# Database connector

Read-only database evidence, for the questions that code alone cannot settle:
does the row actually persist, is the relationship what the model assumes, is
this really cross-tenant.

## Configure

```yaml
# codex-mcp.yaml
connectors:
  database:
    enabled: true
    kind: database        # enables SQL statement policy on every call
    transport: stdio
    command: npx
    args: ['-y', 'your-db-mcp-server']
    maxRows: 500
    timeoutMs: 10000
```

Point it at a **read-only replica with a read-only database user** where you can.
codex-mcp's policy layer is a second line of defense, not a substitute for one.

## What the policy allows

| Statement | |
|---|---|
| `SELECT`, `WITH ... SELECT`, `TABLE`, `VALUES` | allow |
| `SHOW`, `DESCRIBE`, `DESC` | allow |
| `EXPLAIN` (without `ANALYZE`) | allow |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT` | deny |
| `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE` | deny |
| `CALL`, `EXEC`, `DO` — any stored mutation | deny |
| `BEGIN`, `COMMIT`, `ROLLBACK`, `SET`, `LOCK` | deny |

And, specifically:

- **one statement per call.** `SELECT 1; DELETE FROM users` is refused as a
  multi-statement payload, not partially executed.
- **comments and literals are stripped before scanning**, so `SELECT 1 /* ok */;
  UPDATE users SET x = 1` is caught, and `WHERE note = 'please delete this'` is
  not a false positive.
- **`EXPLAIN ANALYZE` is refused** — it executes the plan, including anything
  mutating beneath it.
- **`INTO OUTFILE`, `INTO DUMPFILE`, `FOR UPDATE`, `RETURNING` are refused** —
  they write or lock.
- **side-effecting functions are refused**: `pg_sleep`, `pg_read_file`,
  `load_file`, `nextval`, `xp_cmdshell`, `dblink_exec`, and similar.
- **a row cap is injected** when a `SELECT` has no `LIMIT` of its own, and a
  caller-supplied `limit` is clamped to `maxRows`.

A refused statement never reaches the database. `tests/security/` asserts this
by checking that the downstream server logged no call at all.

## What Codex is told

The prompt constrains *when* to query, not just how:

> Query the database only when it changes a verdict: persistence behavior,
> relationships, tenant ownership, state transitions, schema/migration behavior,
> data integrity, or verifying a reported bug. Do not browse the database for
> general context.

## Generic executors

A tool named `execute_query` or `run_sql` is classified `unknown` and withheld —
its name says nothing about what a caller might pass it. Prefer a connector that
exposes a scoped `read_query` / `query_readonly` tool, which classifies as read
and still passes through the full statement policy.

## When it is unavailable

The review proceeds and records:

```json
{
  "area": "database",
  "detail": "No database connector is configured; persistence and data-integrity claims cannot be verified against real data."
}
```

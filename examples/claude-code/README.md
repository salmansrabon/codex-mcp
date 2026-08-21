# Claude Code integration

The whole integration is: register the server, add one rule.

## 1. Register the server

```bash
claude mcp add codex-mcp -- codex-mcp start
```

Or commit [`.mcp.json`](./.mcp.json) to the **project root** — not `.claude/`,
which holds a different set of files and will ignore it.

Register in one place only: `claude mcp add` writes to `~/.claude.json` at local
scope, which outranks `.mcp.json`. With both present the project file, including
its `env` block, is silently ignored. See the README's precedence table for
where to pin the model.

## 2. Add the rule

Append [`CLAUDE.md.snippet`](./CLAUDE.md.snippet) to the project's `CLAUDE.md`.
That is the entire project-side surface — there is no Codex-specific logic to
write, and nothing here assumes anything about your repository layout.

## 3. Verify

```bash
codex-mcp doctor --project /path/to/project
```

## What the flow looks like

```text
User: "Create test cases for DEV-2951."

Claude
  ├─ reads the ticket
  ├─ reads the implementation
  ├─ creates or reads blast-radius, if the workflow has one
  ├─ creates or reads a test charter, if the workflow has one
  ├─ generates 24 candidate test cases
  ├─ runs its own adversarial pass, if the project has one
  └─ holds the revised candidates in memory

Claude → codex_qualify
  { reviewType, project.root, task.id, artifacts.*, candidate.testCases }

codex-mcp
  ├─ checks Codex auth
  ├─ runs Codex read-only in the project root
  ├─ Codex reads the requirement directly, if a connector is configured
  ├─ Codex inspects the diff, the implementation, the existing tests
  ├─ Codex reads blast-radius and charter as claims to verify
  ├─ Codex queries the database only where it changes a verdict
  ├─ Codex derives expected coverage independently
  └─ Codex compares that against the 24 candidates

codex-mcp → PASS | CHANGES_REQUIRED | INCONCLUSIVE
  accepted · modify · remove · missing · disagreements · limitations

Claude
  ├─ verifies each objection against the cited evidence
  ├─ applies what the evidence supports
  ├─ rejects what it does not, recording why
  └─ writes the FINAL test report
```

Bug review is identical with `reviewType: "bugs"`.

## Example calls

[`example-request.json`](./example-request.json) — a test-design request.
[`example-bug-request.json`](./example-bug-request.json) — a bug request.
[`example-response.json`](./example-response.json) — what comes back.

# Requirement connector (Jira and equivalents)

Point codex-mcp at any MCP server that can read issues. Codex then reads the
requirement **itself** rather than trusting the authoring agent's summary of it —
which is the difference between verifying coverage and verifying someone's
interpretation of coverage.

## Configure

```yaml
# codex-mcp.yaml
connectors:
  jira:
    enabled: true
    kind: jira            # drives normalization to requirement.read / requirement.search
    transport: stdio
    command: npx
    args: ['-y', 'your-jira-mcp-server']
    env:
      JIRA_BASE_URL: https://your-org.atlassian.net
      # Credentials belong to the connector, not to codex-mcp. Prefer a server
      # that reads them from its own keychain or config over putting them here.
```

`kind` matters more than the connector's name. Any server whose tools read
issues works — Jira, Linear, GitHub Issues, Azure Boards, an internal service.

## Verify

```bash
codex-mcp doctor
```

```text
[  ok  ] Connector: jira
           4 read-only tool(s) exposed, 5 withheld by policy.
```

Then, for the full picture including *why* each tool was withheld, call
`codex_capabilities` from your MCP client.

## What gets through

| Tool | Classified | Exposed |
|---|---|---|
| `get_issue`, `getJiraIssue`, `get_jira_ticket` | read | yes → `requirement.read` |
| `search_issues`, `search_jira_by_jql` | read | yes → `requirement.search` |
| `get_comments`, `list_linked_issues` | read | yes |
| `create_issue` | write | no |
| `add_comment`, `transition_issue`, `assign_issue` | write | no |
| `delete_issue` | destructive | no |

Names are classified by their verbs, and any hint of mutation beats any hint of
reading. A tool called `sync_board` is refused even if it mostly reads, because
its description admits it creates cards.

## Read-only tools with unusual names

If a genuinely read-only tool does not classify — say `resolve_epic_tree` —
allowlist it by name:

```yaml
connectors:
  jira:
    allowTools:
      - resolve_epic_tree
      - jira_fetch_*        # trailing glob
```

An allowlist can rescue an *unclassified* tool. It can never expose one
classified `write` or `destructive`; that refusal is not negotiable.

## When it is unavailable

If the connector fails to start, the review still runs. Codex falls back to the
requirement text in `task.description` / `task.acceptanceCriteria`, and the
response records the gap:

```json
{
  "area": "requirement",
  "detail": "No requirement connector is configured, so \"DEV-123\" could not be read independently; the review relies on requirement text supplied by the authoring agent."
}
```

Missing evidence is a fact about the review, not a reason to abandon it.

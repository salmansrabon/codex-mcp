# Custom connectors

Any MCP server can become a read-only evidence source. Adding one requires no
change to review code — the broker discovers its tools, classifies them, and
exposes the safe ones.

## Configure

```yaml
# codex-mcp.yaml
connectors:
  testrail:
    enabled: true
    kind: testmanagement
    transport: stdio
    command: npx
    args: ['-y', 'your-testrail-mcp-server']

  artifacts:
    enabled: true
    kind: external_file
    transport: stdio
    command: npx
    args: ['-y', 'your-ftp-mcp-server']

  internal-tools:
    enabled: true
    kind: custom
    transport: http
    url: https://mcp.internal.example.com/mcp
    headers:
      X-Team: qa
```

## `kind`

`kind` selects normalization and per-kind rules. It is inferred from the
connector name when omitted, so set it explicitly if the name is not obvious.

| kind | Normalized capabilities | Extra rules |
|---|---|---|
| `jira` | `requirement.read`, `requirement.search` | — |
| `database` | `database.schema`, `database.query_readonly` | SQL statement policy, row caps |
| `testmanagement` | `testmanagement.read`, `testmanagement.search` | — |
| `external_file` | `external_file.list`, `external_file.read` | — |
| `custom` | none | tools keep their own names |

Normalization is advisory. An unmapped tool is still exposed under
`<connector>__<tool>`; the vocabulary just lets the reviewer prompt talk about
"the requirement" without knowing your connector's naming conventions.

## Classification

Every discovered tool is classified from its name and description:

```text
read         → allow
write        → deny
destructive  → deny
unknown      → deny unless explicitly allowlisted
```

The classifier is asymmetric on purpose. Any mutation signal beats any read
signal, and a tool must look *positively* read-only to be exposed. Downstream
tool names and descriptions are third-party text — treating them as trustworthy
is how a "reviewer" ends up filing tickets.

```yaml
connectors:
  internal-tools:
    allowTools:
      - fetch_deployment_manifest    # read-only, but the name has no read verb
      - lookup_*                     # trailing glob
    denyTools:
      - get_customer_pii             # reads, but must not be exposed to a reviewer
```

- `allowTools` rescues an **unknown** tool.
- `allowTools` can **never** expose a `write` or `destructive` tool.
- `denyTools` wins over everything, including a read classification.

`allowUnknownDownstreamTools: true` relaxes the unknown case globally. Prefer
per-connector `allowTools`: a blanket relaxation applies to tools the server has
not shipped yet.

## Isolation

- Codex never connects to your connector; it connects to the codex-mcp broker.
- Policy is re-checked on **every call**, not only at discovery — a downstream
  server can change its tool list mid-session.
- A connector process receives only `PATH`, `HOME`, and the `env` its own config
  declares. It never sees the codex-mcp process environment.
- Responses are redacted before Codex sees them.
- An unreachable connector becomes a recorded limitation, not a failed review.

## Check your work

```bash
codex-mcp doctor
```

Then call `codex_capabilities` for the per-tool breakdown, including the reason
each withheld tool was withheld.

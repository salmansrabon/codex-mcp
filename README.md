# codex-mcp

An independent, read-only quality gate for QA artifacts.

`codex-mcp` is a standalone MCP server that runs Codex as an **adversarial second
reviewer** over candidate test cases and bug findings — *before* the authoring
agent writes its final report. Codex inspects the repository itself, forms its
own view of what should be covered or whether a defect is real, and only then
compares that against the candidate it was given.

It returns a **review delta**. It never writes your artifact.

```text
Authoring agent (Claude, or any MCP client)
        │  gathers the requirement, reads the code, drafts candidates
        ▼
  candidate result — in memory, not yet written
        │
        ▼  codex_qualify
   codex-mcp ──► Codex (read-only sandbox, rooted at your repo)
        │           ├─ reads the code, the diff, the existing tests
        │           ├─ reads blast-radius / test-charter if present
        │           └─ reads Jira / DB / other MCPs if configured, read-only
        ▼
  review delta: accept · modify · remove · missing · evidence · limitations
        │
        ▼
Authoring agent reconciles, then writes the FINAL artifact
```

**Contents** · [Install](#install) · [Connect to a project](#connect-to-a-project)
· [Use it](#use-it) · [Configuration](#configuration)
· [Evidence connectors](#evidence-connectors) · [GitHub](#reviewing-a-github-repository)
· [Permission boundary](#the-permission-boundary)
· [API contract](#the-contract) · [Troubleshooting](#troubleshooting) · [Testing](#testing)

---

## Why a second model, and why read-only

The failure mode this addresses is not "the agent cannot write test cases". It
is that an agent grading its own work agrees with itself. A reviewer that shares
the author's context inherits the author's blind spots.

So two properties are load-bearing:

**Independence.** Codex is prompted to derive expected coverage *before* it looks
closely at the candidate, and to try to falsify each bug claim rather than
confirm it. Anchoring it on the candidate first would produce a more agreeable
reviewer and a less useful one.

**Read-only.** The reviewer runs in Codex's `read-only` sandbox, and every
downstream system it can reach is filtered through a policy layer that classifies
each tool and refuses anything that mutates. A quality gate you cannot safely
point at a live repository is a quality gate nobody runs.

Neither model is authoritative. Source evidence is:

```text
requirement / runtime / code / DB / external evidence  >  model opinion
```

---

## Install

Requires **Node 20+** on Linux, macOS, or Windows. Four commands, once per
machine — identical on all three.

```bash
# 1. The Codex CLI. codex-mcp drives it, and it owns your credentials.
npm install -g @openai/codex@latest

# 2. codex-mcp itself.
git clone <this-repo> codex-mcp && cd codex-mcp
npm install && npm run build && npm link

# 3. Sign in. A browser opens once; that is the whole flow.
codex-mcp login

# 4. Write a config, detecting any MCP servers already on this machine.
codex-mcp init --model gpt-5.6-sol
```

Then confirm before trusting it:

```bash
codex-mcp doctor
```

Every line should read `ok`. `doctor` is read-only and safe against a live
project — see [Troubleshooting](#troubleshooting) for what each failure means.

> The npm name `codex-mcp` belongs to an unrelated package. Install from source
> as above, or publish under your own scope.

### Windows

Nothing extra to configure — the commands above are the whole setup. Worth
knowing why, because the failure it avoids is a confusing one.

npm does not install a `codex.exe`. It installs `codex.cmd` (plus a `.ps1` and
an extensionless shell script), and Windows resolves the `.cmd` through
`PATHEXT` — something `cmd.exe` does but `CreateProcess`, which Node's `spawn`
uses, does not. A bare `codex` therefore fails with `spawn codex ENOENT` even
though `codex --version` works in your terminal, and since CVE-2024-27980 Node
will not run a `.cmd` without a shell either. `doctor` used to read this as a
missing CLI and tell you to reinstall, which never helped.

codex-mcp now resolves the launcher itself and passes arguments through
`cmd.exe` with quoting that survives the shim's double parse, so a project path
containing `&` or a connector env value containing `|` reaches Codex intact.
POSIX is untouched: the resolver returns immediately off Windows.

`CODEX_BINARY` also accepts a script rather than an installed CLI — its shebang
is honoured on Windows, where the OS would otherwise refuse the file.

### What `init` does

It writes `~/.config/codex-mcp/codex-mcp.yaml`, and a `.env` beside it if it
found downstream MCP servers in conventional locations:

```console
$ codex-mcp init --dry-run
Would write into /home/you/.config/codex-mcp
  codex-mcp.yaml  (new)
  .env            (new)

Detected:
  jira-mcp (jira) -> /home/you/jira-mcp/src/index.js
  db-mcp (database) -> /home/you/db-mcp/dist/index.js
```

Detected servers are written as connector entries you can enable, with their
paths kept in `.env` so the YAML stays portable across machines. `--force`
overwrites; without it, existing files are kept.

`init` is the **only** command that writes anything, and it runs before any
review exists. Reviews themselves are strictly read-only.

Prefer to write the config yourself? Copy
[`codex-mcp.example.yaml`](codex-mcp.example.yaml) to
`~/.config/codex-mcp/codex-mcp.yaml` — every value in it is annotated and is the
built-in default unless its comment says otherwise.

---

## Authentication

**One command, once per machine:**

```bash
codex-mcp login          # browser opens; sign in to ChatGPT
codex-mcp auth-status    # confirm
```

Credentials land in the Codex CLI's own store (`~/.codex/auth.json`, mode `0600`)
and are refreshed by it. They persist across reboots and terminals — you do not
log in again per project or per session.

**codex-mcp never handles the credential itself.** It has no OAuth client, no
callback listener, no token storage. It shells out to `codex login status` and
reads yes/no. Nothing here can open a browser during a review: an
unauthenticated call fails fast instead.

```json
{ "code": "CODEX_AUTH_REQUIRED", "message": "Codex is not authenticated. Run `codex-mcp login`." }
```

### Using an API key instead

| Mode | Command | Uses |
|---|---|---|
| `chatgpt` (default) | `codex-mcp login` | Browser OAuth, ChatGPT subscription |
| `api` | `codex-mcp login --mode api` | An OpenAI API key |

```bash
codex-mcp login --mode api                    # hidden prompt
printenv OPENAI_API_KEY | codex-mcp login --mode api
```

The key is read from `--api-key`, then `OPENAI_API_KEY`, then a hidden prompt,
and piped to `codex login --with-api-key` over **stdin** — never an argv element,
so it stays out of your process table and shell history. The Codex CLI stores it;
codex-mcp does not.

Set `auth.mode` in your config to match. If the CLI is authenticated in a
different mode than the config claims, reviews fail with a clear error rather
than silently billing the wrong account.

---

## Connect to a project

Pick **one** of these. Registering twice is the most common setup mistake — see
the warning below.

### Option A — one project, committed

Create `.mcp.json` in the **project root** — not `.claude/`, which holds a
different set of files and will ignore it:

```json
{
  "mcpServers": {
    "codex-mcp": { "command": "codex-mcp", "args": ["start"] }
  }
}
```

Commit it. Every teammate who has run [Install](#install) now has the gate, using
their own model choice from their own config.

### Option B — all your projects, not committed

```bash
claude mcp add codex-mcp -- codex-mcp start
```

This writes to `~/.claude.json` and applies wherever you work.

> **Register in one place only.** `claude mcp add` writes at *local scope*, which
> **outranks** `.mcp.json`. With both present, the project file — including any
> `env` in it — is silently ignored. Run `claude mcp remove codex-mcp` if you are
> switching to `.mcp.json`.

Restart Claude Code. `/mcp` should now list `codex-mcp` with three tools. If it
does not, see [Troubleshooting](#troubleshooting).

Other MCP clients take the same two fields — `command: codex-mcp`,
`args: ["start"]` — in whatever config file they use.

---

## Use it

### Make it automatic

Add one rule to the project's `CLAUDE.md`. This is the entire integration
surface — no project-specific Codex logic anywhere:

```markdown
## Independent QA qualification

Before finalizing test cases or bug reports, send the complete candidate result,
project root, task/requirement context, and any available blast-radius or
test-charter to codex-mcp for independent qualification.

Reconciling means verifying each objection against the evidence it cites — not
accepting it. Apply what the evidence supports. Reject what it does not, and note
why. codex-mcp is a second opinion, not an approver.

One pass is normal. Run a second only if the first forced substantial high-risk
changes.
```

With that in place you write your normal request and the gate runs itself:

> Create test cases for DEV-2951.

The agent gathers the requirement, reads the code, drafts candidates, calls
`codex_qualify`, reconciles, then writes the report.

### Ask for it explicitly

When there is no rule, or you want it on something already drafted:

> Before you write the report, send these test cases to codex-mcp with
> `project.root` set to `/path/to/repo` and `task.id` DEV-2951. Show me what it
> objects to and whether you agree, then write the final version.

> Run the bug findings you just wrote through `codex_qualify` with
> `reviewType: "bugs"`. For anything it calls a false positive, check the code it
> cites before you drop the finding.

> Qualify these against codex-mcp, but only report objections where the cited
> evidence actually holds up. Tell me which ones you rejected and why.

Useful variations:

| You want | Add to your prompt |
|---|---|
| Both tests and bugs in one go | `use reviewType "combined"` |
| Focus on one risk area | `set options.focus to "authorization and tenant isolation"` |
| Skip the database | `set options.useDatabase to false` |
| Feed it your artifacts | `pass artifacts.blastRadiusPath and artifacts.testCharterPath` |

### Reading what comes back

Ask your agent to surface these rather than silently acting on them:

- **`missing`** — coverage it says you lack. Check the cited `file:line` is real.
- **`modify`** — your expectation contradicts the code. Usually the sharpest finding.
- **`remove`** — redundant. Verify the thing it says supersedes yours actually does.
- **`limitations`** — what it *could not* verify. A confident review with a long
  limitations list is a narrow review; read this before trusting the rest.
- **`disagreements`** — it and your agent read the same evidence differently.
  These need you, not either model.

A good follow-up prompt:

> For each objection, tell me the evidence it cited and whether you verified it
> yourself. List anything you rejected and why.

### What it will not do

It never edits files, commits, pushes, writes to Jira or the database, or writes
your report. If your agent claims codex-mcp changed something, it did not — check
`git status`.

---

## Reconciliation — the part that matters

`codex-mcp` never tells you to accept Codex. Every response carries:

```json
{
  "reconciliation": {
    "instruction": "This is an independent second opinion, not a verdict...",
    "codexIsNotAuthoritative": true
  }
}
```

```text
Codex objection
      │
      ▼
Author verifies the cited evidence
      │
      ├─ evidence supports it   → apply
      ├─ evidence does not      → reject, and record why
      └─ unclear                → investigate
```

Then **you** write the final artifact.

### Loop protection

There is no multi-turn handshake between the reviewer and the authoring agent.
One `codex_qualify` call is one independent review returning one structured
delta; reconciliation happens on your side.

**`review.maxPasses` defaults to `1`.** A second pass carries no record of the
first — no previous findings, no author responses, no revised candidate — so it
is not a continuation, it is the same review run twice at full cost. Raising the
limit is supported and will work; it just buys repeated work rather than
progress. A request above the limit is refused, and `meta.furtherPassesAllowed`
reports the budget.

Real multi-pass review needs a continuation contract carrying `reviewId`,
`previousFindings`, `authorResponses`, and `revisedCandidate`. That is deferred;
see [Limitations](#known-limitations).

Iterating until the two models agree is not the goal in any case — agreement is
cheap, and reaching it usually means one of them stopped thinking.

---

## Configuration

Settings live in **`~/.config/codex-mcp/codex-mcp.yaml`**. That is the one file
to edit. [`codex-mcp.example.yaml`](codex-mcp.example.yaml) is the annotated
version, with the current Codex model ids.

An absent config file is fully supported — the server starts on defaults, which
are the safe ones. What you lose is the model pin and every connector, since
connectors can *only* be defined in YAML.

### Where the model goes

```yaml
review:
  model: gpt-5.6-sol
  requireModel: true
```

Three layers can set it. Highest wins:

| Layer | Scope | Use it when |
|---|---|---|
| `env` in `.mcp.json` | one project, everyone who clones it | the team must all review with one specific model |
| `review.model` in `codex-mcp.yaml` | this machine, every project | **normal setup** — one operator, several projects |
| built-in default | — | you accept whatever Codex currently defaults to |

Keep the model in **one** layer. A key set in two places makes the lower copy
dead — editing it appears to do nothing. `doctor` warns when the model is set in
both and the two disagree.

To pin a project for a whole team, add `env` to the `.mcp.json` from
[Option A](#option-a--one-project-committed):

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "codex-mcp",
      "args": ["start"],
      "env": { "CODEX_MODEL": "gpt-5.6-sol", "CODEX_REASONING_EFFORT": "high" }
    }
  }
}
```

That guarantees everyone gets the same reviewer, which is worth a lot when
findings are compared across a team. The cost: a teammate whose Codex CLI is too
old for that model gets a hard `CODEX_MODEL_NOT_AVAILABLE` telling them to run
`codex update`. That failure is deliberate — the alternative is them quietly
getting a weaker reviewer and trusting its verdict.

**Which model.** Prefer a frontier model. The entire value here is catching what
the authoring agent missed, and a cheaper reviewer mostly agrees with whatever it
is shown. Set `requireModel: true` on a shared gate so a change to the Codex
default cannot quietly alter review quality. An unavailable model raises
`CODEX_MODEL_NOT_AVAILABLE`; codex-mcp will not fall back to another one.

### Every setting, and its environment variable

Precedence: **environment > `codex-mcp.yaml` > defaults.** The variables exist to
override one YAML value without editing the file — in `.mcp.json`'s `env` to pin
a project, or in the shell for a one-off.

| `codex-mcp.yaml` | Environment variable | Default |
| --- | --- | --- |
| `review.model` | `CODEX_MODEL` | *(none — Codex decides)* |
| `review.requireModel` | `CODEX_REQUIRE_MODEL` | `false` |
| `review.reasoningEffort` | `CODEX_REASONING_EFFORT` | `high` |
| `review.sandbox` | `CODEX_SANDBOX` | `read-only` |
| `review.ephemeral` | `CODEX_EPHEMERAL` | `true` |
| `review.maxPasses` | `MAX_REVIEW_PASSES` | `1` |
| `review.timeoutMs` | `REVIEW_TIMEOUT_MS` | `900000` |
| `review.maxConcurrentReviews` | `MAX_CONCURRENT_REVIEWS` | `2` |
| `review.maxArtifactBytes` | `MAX_ARTIFACT_BYTES` | `200000` |
| `review.maxCandidateItems` | `MAX_CANDIDATE_ITEMS` | `500` |
| `auth.mode` | `AUTH_MODE` | `chatgpt` |
| `auth.codexBinary` | `CODEX_BINARY` | `codex` |
| `permissions.project.read` | `PROJECT_READ_ENABLED` | `true` |
| `permissions.git.read` | `GIT_READ_ENABLED` | `true` |
| `permissions.allowUnknownDownstreamTools` | *(none)* | `false` |
| `memory.enabled` | `PROJECT_MEMORY_ENABLED` | `true` |
| `logging.level` | `LOG_LEVEL` | `info` |

Connector settings **invert** that precedence: the YAML wins, because it is
explicit per-connector intent and these variables are coarse fallbacks for when
no YAML says otherwise.

| Environment variable | Falls back for |
| --- | --- |
| `JIRA_ENABLED` | `enabled`, on a connector *named* `jira` |
| `DATABASE_ENABLED` | `enabled`, on one named `database` or `db` |
| `CUSTOM_MCPS_ENABLED` | `enabled`, on every other connector |
| `DB_MAX_ROWS` / `DB_TIMEOUT_MS` | `maxRows` / `timeoutMs` |

Those toggles match the connector's **name, not its kind** — connectors called
`jira-mcp` and `db-mcp` match neither `jira` nor `database`, so both fall under
`CUSTOM_MCPS_ENABLED`. Setting `enabled:` in the YAML avoids the question
entirely.

Two variables have no YAML equivalent, since they are read before any config file
is located: `CODEX_MCP_CONFIG` (path to the config file) and `XDG_CONFIG_HOME`
(where `~/.config/codex-mcp/` is looked for).

### Where the config file is found

First hit wins:

```text
--config <path>  →  $CODEX_MCP_CONFIG  →  ./codex-mcp.yaml  →  ~/.config/codex-mcp/codex-mcp.yaml
```

`doctor` prints which one it loaded. A `.env` beside the chosen file is read if
present; nothing requires one. It is worth having only for values that differ per
machine — connector paths the YAML references as `${JIRA_MCP_PATH}` — and even
those can carry a `${VAR:-fallback}` default instead.

**Never put credentials in `.env` or the YAML.** `CHATGPT_TOKEN`,
`SESSION_TOKEN`, `ACCESS_TOKEN`, and `REFRESH_TOKEN` are ignored outright, and
their presence is reported as a configuration warning. Codex authentication
belongs to the Codex CLI and your OS credential store.

---

## Evidence connectors

Codex never talks to Jira or your database directly. It connects to the
**codex-mcp evidence broker**, a separate read-only process that discovers each
downstream server's tools, classifies them, and forwards only what passes policy
— re-checking on every call, not just at discovery.

A connector launches a downstream MCP server, so setting one up is two
decisions: which server to launch, and how it gets its credentials. Those are
independent, and the second one has two answers.

### A — a published server, credentials in the connector

For a server you run straight from npm and configure through the environment.
The `env` block is the whole configuration:

```yaml
# ~/.config/codex-mcp/codex-mcp.yaml
connectors:
  jira:
    enabled: true
    kind: jira
    approval: once
    transport: stdio
    command: npx
    args: ['-y', 'your-jira-mcp-server']
    env:
      JIRA_BASE_URL: https://your-org.atlassian.net
      JIRA_EMAIL: you@your-org.com
      JIRA_API_TOKEN: ${JIRA_API_TOKEN}    # from the .env beside this file

  database:
    enabled: true
    kind: database
    approval: once
    transport: stdio
    command: npx
    args: ['-y', 'your-db-mcp-server']
    env:
      DB_DIALECT: mysql
      DB_HOST: db.internal
      DB_PORT: '3306'                      # every value must be a string
      DB_USERNAME: qa_readonly
      DB_PASSWORD: ${DB_PASSWORD}
    allowTools: ['execute_query']
    denyTools: ['update_query']
    maxRows: 500
```

`env` is passed through untouched — codex-mcp never reads these keys, so they
have to match what your server expects. `DB_*` is a common spelling, not a
schema: a MySQL-specific server that reads `MYSQL_HOST` will ignore `DB_HOST`,
and one that wants a single DSN wants `DATABASE_URL` instead. Check the server's
own README first. Splitting the connection into parts is worth it where the
server supports it — the password stays one isolated `${VAR}` instead of being
buried in a URL that is awkward to redact and easy to paste somewhere public.

Write the secret as a `${VAR}` reference rather than a literal. It resolves from
the `.env` beside the config or from the environment, an unset one is reported by
`doctor` instead of failing at review time, and `${VAR:-fallback}` supplies a
default. This config file is the one people commit or share; keep it free of
anything you would not paste into a pull request.

### B — a server you already have, credentials in that project

For an MCP server checked out locally and already working with your editor.
Point at its entrypoint, set `cwd`, and **omit `env` entirely** — servers of this
shape load their own `.env` on startup:

```yaml
connectors:
  jira:
    enabled: true
    kind: jira
    approval: once
    transport: stdio
    command: node
    args: ['/path/to/jira-mcp/src/index.js']
    cwd: /path/to/jira-mcp
    denyTools: ['create_jira_ticket', 'update_jira_ticket']

  database:
    enabled: true
    kind: database
    approval: once
    transport: stdio
    command: node
    args: ['/path/to/db-mcp/dist/index.js']
    cwd: /path/to/db-mcp
    allowTools: ['execute_query']
    maxRows: 500
    timeoutMs: 10000
```

Prefer B when you have the choice. No credential enters codex-mcp's config at
all, and the server keeps one set of credentials whether codex-mcp drives it or
your editor does — rotate the token in one place and both follow.

Check how the server finds its `.env` before relying on this. One that resolves
against its own file (`resolve(__dirname, '../.env')`) works regardless of `cwd`;
one that reads the *working directory* needs `cwd` set to its project root, which
is the case worth setting `cwd` for even when it looks redundant.

If the database server can reach more than one database, point the connector at
the narrowest one. The reviewer picks its own connection per call, so a server
that can see production is one prompt away from querying it.

`kind` drives normalization onto a stable vocabulary — `requirement.read`,
`database.query_readonly`, `testmanagement.search`, `external_file.read` — so the
reviewer prompt can ask for "the requirement" without knowing whether your
connector calls it `getJiraIssue` or `get_jira_ticket`. Unmapped tools are still
exposed under their own names; adding a new read-oriented MCP requires no code
change.

A downstream server receives only `PATH`, `HOME`, and the `env` its own config
declares — never the codex-mcp process environment.

An unreachable connector **degrades the review to a recorded limitation** rather
than failing it. Missing evidence is a fact about the review, and the response
says so.

Run `codex-mcp doctor` after adding one. Each connector line is labelled with the
key you gave it, and reports how many tools were exposed and how many were
withheld by policy:

```text
[  ok  ] Connector: jira
           3 read-only tool(s) exposed, 2 withheld by policy.
[  ok  ] Connector: database
           6 read-only tool(s) exposed, 1 withheld by policy.
```

The withheld counts are the `denyTools` from the samples above — the two Jira
writes and `update_query`. A count higher than your `denyTools` list means the
classifier withheld something on its own; `codex_capabilities` names which.

### Asking permission — the `approval` field

Reading the project you were handed needs no permission: you supplied
`project.root`, so reading it *is* the request. Reaching **outside** it — a
ticket tracker, a production database, a file server — is a separate decision,
and `enabled: true` in a config file written weeks ago is not informed consent
for today's review.

| `approval` | Behavior |
|---|---|
| `always` | Ask before every review |
| `once` | Ask once per server session — **the default** |
| `trusted` | Never ask |

The prompt is delivered through MCP **elicitation**, so it reaches the human in
your MCP client. If your client cannot show prompts, the connector is **skipped**
and recorded in `limitations` — not silently allowed. A prompt nobody can see is
not consent. Set `approval: trusted` on connectors you have already vetted.

### Requirements

When a `jira`-kind connector is configured and `task.id` is set, Codex reads the
ticket itself and treats any requirement text you passed as *the authoring
agent's interpretation* — a claim to reconcile, not a source. Without a
connector it falls back to the text you supplied and records that it could not
verify it independently.

### Database

Consulted only where it can change a verdict: persistence, relationships, tenant
ownership, state transitions, migrations, data integrity, verifying a reported
defect. The prompt says so explicitly, and the policy layer enforces the rest.

Use a **read-only database account**. codex-mcp refuses every mutating
statement, but a read-only grant is the boundary that does not depend on this
server being correct.

---

## Project memory

A Codex run is stateless: it cannot remember what a previous review of the same
project established, so every review would otherwise rediscover the same
business rules and ownership paths from scratch.

The **server** remembers instead. The reviewer proposes durable facts in a
`projectMemory` array; codex-mcp screens and stores them, and hands the relevant
ones to the next review as evidence.

```text
~/.local/state/codex-mcp/          (or $XDG_STATE_HOME/codex-mcp)
└── projects/
    └── <projectRootId>/
        └── memory.json
```

The id is the same hash reported as `meta.evidence.projectRootId`, so a stored
file and a review result correlate without either recording the path.

Three things keep this from becoming a liability:

- **Nothing is written to your project.** The store lives in codex-mcp's own
  state directory. The read-only guarantee is about your repository and your
  external systems; it was never a claim that the server keeps no state.
- **Nothing is written from inside the sandbox.** Codex still cannot write
  anywhere. Persistence happens in the server process, after the review returns,
  from data that already passed schema validation.
- **Facts are screened before they are kept.** A proposed fact is rejected if it
  carries no evidence, if it reads like a credential or secret, or if it is
  hedged — `might`, `appears to`, `unverified`. Only settled knowledge is stored.

A fact several reviews independently assert gets a confirmation count rather
than a duplicate entry, and stored facts are handed back to the reviewer as
evidence at the same level as a derived artifact: useful, and still checkable.
Where the code now contradicts one, the code wins.

Writes are atomic — written to a temporary file and renamed — so an interrupted
write leaves the previous store intact rather than a truncated file that reads
as "nothing remembered". A store that cannot be read or written degrades to
empty; memory is an optimization, and failing a review over it would be the
wrong trade.

Turn it off with `memory.enabled: false` if you want the server to hold nothing
between reviews. To clear one project, delete its directory under `projects/`.

The invariant this preserves, stated exactly:

> Qualification never modifies the target project or any connected source
> system. codex-mcp writes only to its own config and state directories.

---

## Reviewing a GitHub repository

**codex-mcp reviews a working copy on disk, not a URL.** There is no "paste a
repo link" mode, and that is deliberate — the reviewer reads the code, the diff,
the existing tests, and the project's own conventions, which means it needs the
files. Point it at a clone.

### A whole repository

```bash
git clone git@github.com:your-org/your-repo.git
cd your-repo
```

Then ask your agent, with the absolute path:

> Draft test cases for the checkout flow, then qualify them with codex-mcp using
> `project.root` `/home/you/your-repo`.

If `.mcp.json` lives in that repo, `project.root` is just the repo you already
have open.

### A pull request

Check the PR branch out locally and tell codex-mcp what to diff **against**:

```bash
gh pr checkout 482          # or: git fetch origin pull/482/head:pr-482 && git switch pr-482
```

```json
{
  "reviewType": "combined",
  "project": { "root": "/home/you/your-repo", "branch": "origin/main" },
  "task": { "id": "DEV-2951", "source": "jira", "title": "Archive a resource" },
  "candidate": { "testCases": [], "bugs": [] }
}
```

`project.branch` is the **base ref**, not the branch under review. The reviewer
always reads the checked-out tree; this tells it what to compare against, and it
diffs `<base>...HEAD`. Omit it and codex-mcp tries `origin/HEAD`, `origin/main`,
`origin/master`, `main`, then `master`, recording a limitation if none resolve.

As a prompt:

> I've checked out PR #482. Send my bug findings to codex-mcp with
> `project.root` `/home/you/your-repo` and `project.branch` `origin/main`, then
> show me what it refutes.

Run `git fetch origin` first on a shallow or stale clone — without the base ref
present locally, the diff falls back to the working tree only and the review
loses the change set.

### GitHub as an evidence source

The clone gives codex-mcp the code. To also let it read issues and PR
discussion, add a GitHub MCP server as a connector — it is brokered read-only
like any other, and its write tools are withheld by policy:

```yaml
connectors:
  github:
    enabled: true
    kind: custom
    approval: once
    transport: stdio
    command: npx
    args: ['-y', 'your-github-mcp-server']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ''
```

Use a **read-only token**. codex-mcp refuses every mutating tool it classifies,
but a token that cannot write is the boundary that does not depend on this
server being correct. Then run `codex-mcp doctor` and check the exposed/withheld
counts:

```text
[  ok  ] Connector: github
           9 read-only tool(s) exposed, 6 withheld by policy.
```

A tool with an unusual name may land in `deniedTools` as `unknown`; add it to
that connector's `allowTools` if it is genuinely read-only.

Set `kind: jira` instead of `custom` if you track requirements as GitHub issues
and want `task.id` resolved through it — that is what makes the reviewer read
the issue itself rather than trusting the description your agent passed in.

### What it does not do

- It will not clone for you, or accept `https://github.com/org/repo` as
  `project.root`.
- It will not post a review comment, approve a PR, or push anything. The delta
  comes back to your agent; you write the final artifact.
- Private submodules and LFS objects must already be fetched locally.

---

## The permission boundary

The central rule: **Codex may inspect broadly and mutate nothing.**

Read "broadly" literally — see [read scope](#read-scope-is-wider-than-the-project)
below before pointing this at a machine holding secrets you care about.

| Local | |
|---|---|
| Read files, search, list, inspect tests, read artifacts | **allow** |
| `git diff` / `log` / `show` / `status` / `blame` | **allow** |
| Edit, create, delete files | **deny** |
| `git add` / `commit` / `push` / `checkout` / `switch` / `reset` / `clean` | **deny** |
| Shell wrappers, metacharacters, redirection, unknown binaries | **deny** |

| Jira | |
|---|---|
| Read issue, search, comments, linked issues, acceptance criteria | **allow** |
| Create, edit, comment, transition, delete | **deny** |

| Database | |
|---|---|
| Read schema, `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | **allow** |
| `INSERT` / `UPDATE` / `DELETE` / `DROP` / `ALTER` / `TRUNCATE` / stored mutations | **deny** |
| Multi-statement payloads, `EXPLAIN ANALYZE`, `INTO OUTFILE`, `FOR UPDATE`, `RETURNING` | **deny** |

Enforcement, in layers:

1. **Codex's own `read-only` sandbox** — the primary boundary.
2. **Command policy** — argv-based, default-deny. Unknown binaries are refused;
   shell wrappers are refused because their payload cannot be classified.
3. **SQL policy** — comments and string literals are stripped before keyword
   scanning, so a mutation cannot hide inside a quoted value. One statement per
   call, row cap injected when the query has none.
4. **Tool policy** — every downstream MCP tool is classified `read` / `write` /
   `destructive` / `unknown`; only `read` is exposed. `unknown` is denied unless
   explicitly allowlisted, and **no allowlist can rescue a mutating tool** — a
   boundary you can argue your way past is not a boundary.

The classifier is deliberately asymmetric: any hint of mutation beats any hint of
reading, and a tool must look *positively* read-only to be exposed. A tool that
sounds unsafe but is not costs you one line of config; a tool that sounds safe
but is not costs you data.

`tests/security/` asserts all of this, including that a refused call never
reaches the downstream server and that a fixture repository is byte-identical
after a review.

### Read scope is wider than the project

Codex's `read-only` sandbox constrains **writes**, not reads. Inside it, Codex
can read any file your user account can read — not only files under
`project.root`. Verified directly:

```text
$ codex exec --sandbox read-only -C ./proj   "read ../outside.txt"
exec  sed -n '1,$p' ../outside.txt   in .../proj
      succeeded: SECRET_OUTSIDE=canary-9f3a2b
```

The Codex CLI offers no option to narrow read scope; `sandbox_permissions` only
grants further access. So the honest statement of the guarantee is:

> Nothing is modified, anywhere. Reads are bounded by your OS file permissions,
> not by `project.root`.

`project.root` steers *where the reviewer looks* — it is the working directory
and the subject of the prompt — but it is not a read jail.

What this means in practice:

- A `.env`, private key, or credentials file anywhere readable by your user is
  reachable by the reviewer, and its contents may be sent to OpenAI as part of
  the model's context.
- codex-mcp's own artifact-path containment (`assertArtifactPathAllowed`) stops
  *codex-mcp* from reading files outside the project into the prompt. It does not
  and cannot constrain what Codex reads inside its own sandbox.
- Findings are redacted before they are logged, but that is a logging control,
  not a containment one.

If that matters for your environment, run codex-mcp inside a container or VM
with only the project mounted. That is the only reliable way to bound reads
today.

### What the reviewer reads by design

Within the project root it reads **everything**, including dot-directories.
Hiding `.claude`, `.cursor`, `.github`, or a team's own `.qa` from the reviewer
is how it ends up ignoring the very rules the project wrote down for it. Known
tool caches (`.venv`, `.pytest_cache`, `.next`, and the like) are still listed
but are not recommended to it as reading material.

Convention files — `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `TESTING.md`,
`.cursorrules`, `CODEOWNERS` — are surfaced to the prompt as "read these first".

---

## The contract

### `codex_qualify`

Required: `reviewType`, `project.root`, and a candidate set matching the review
type. Everything else is optional and **never blocks a review**.

```json
{
  "reviewType": "test-design",

  "project": { "root": "/absolute/path/to/project", "branch": "origin/main" },

  "task": {
    "id": "DEV-123",
    "source": "jira",
    "title": "Archive a resource",
    "description": "A user may archive a resource belonging to their own tenant.",
    "acceptanceCriteria": ["Archiving an active resource sets status to archived."]
  },

  "artifacts": {
    "blastRadiusPath": "docs/blast-radius.md",
    "testCharterPath": "docs/test-charter.md"
  },

  "candidate": {
    "testCases": [{ "id": "TC-001", "title": "Archive an active resource", "priority": "high" }],
    "bugs": []
  },

  "options": { "useJira": true, "useDatabase": true, "useExternalMcps": true }
}
```

Candidates travel **in the payload**. They have not been written anywhere yet,
and requiring a temporary report file would defeat the point.

Artifact paths are resolved inside `project.root`; a path escaping it is refused.

#### Review types

| Type | Reviews |
|---|---|
| `test-design` | Coverage, redundancy, weak assertions, missing high-value scenarios |
| `bugs` | Whether each finding is real, a false positive, a duplicate, or unproven |
| `combined` | Both, as two separate Codex runs — fusing the prompts degrades both |

#### Test-design result

```json
{
  "status": "CHANGES_REQUIRED",
  "summary": { "accepted": 18, "modify": 2, "remove": 1, "missing": 3 },
  "accepted": ["TC-001", "TC-002"],
  "modify": [{
    "candidateId": "TC-014",
    "reason": "Expected state contradicts persistence logic.",
    "evidence": [{ "source": "code", "location": "src/session/service.ts:143" }],
    "recommendation": "Queue should remain persisted after this transition."
  }],
  "remove": [{ "candidateId": "TC-022", "reason": "Duplicates TC-018.", "supersededBy": "TC-018" }],
  "missing": [{
    "title": "Verify cross-tenant access is rejected",
    "priority": "high",
    "dimension": "authorization",
    "reason": "Target lookup accepts an externally supplied identifier.",
    "evidence": [{ "source": "code", "location": "src/resource/controller.ts:82" }]
  }],
  "disagreements": [],
  "limitations": []
}
```

#### Bug result

```json
{
  "status": "CHANGES_REQUIRED",
  "summary": { "verified": 1, "falsePositive": 1, "needsMoreEvidence": 0, "other": 0 },
  "findings": [{
    "candidateId": "BUG-003",
    "verdict": "FALSE_POSITIVE",
    "confidence": "high",
    "severityAssessment": null,
    "reason": "Ownership validation occurs in router-level middleware.",
    "evidence": [
      { "source": "code", "location": "src/routes/users.ts:42" },
      { "source": "code", "location": "src/middleware/access.ts:91" }
    ],
    "recommendation": "Remove the finding unless runtime evidence contradicts the middleware."
  }],
  "limitations": []
}
```

`status`: `PASS` · `CHANGES_REQUIRED` · `INCONCLUSIVE` · `ERROR`

**`status` is computed by codex-mcp, not reported by the model.** A model asked
whether its own output requires action will sometimes say no while handing back
a delta that plainly does. It is derived from the content: any `modify`,
`remove`, `missing`, or material `disagreement` makes it `CHANGES_REQUIRED`; a
material `limitation` or an unreachable verdict makes it `INCONCLUSIVE`. A
review with an unresolved material disagreement can never come back `PASS`.
`ERROR` and `INCONCLUSIVE` pass through when the reviewer sets them, since those
are statements about what it was able to do rather than about the delta.

`verdict`: `VERIFIED` · `FALSE_POSITIVE` · `NEEDS_MORE_EVIDENCE` ·
`SEVERITY_DISAGREEMENT` · `DUPLICATE_OR_ALREADY_COVERED` · `INCONCLUSIVE`

#### What the envelope guarantees

`codex-mcp` normalizes the reviewer's output before returning it, because a model
grading a list will sometimes drift:

- ids the reviewer invented are dropped, with a note — you cannot act on a
  reference to a test case that does not exist;
- a candidate the reviewer never mentioned is recorded as **unreviewed**, never
  promoted to accepted, because silence is not approval;
- a bug with no verdict becomes an explicit `INCONCLUSIVE`;
- `summary` counts are recomputed from the arrays;
- `status` is derived from the delta, not from the reviewer's self-assessment.

`meta.evidence` reports what the review was actually based on — whether git,
blast-radius, test-charter, and requirement access were available, and which
connectors were reachable. The project path itself is never logged or returned;
`meta.evidence.projectRootId` is a hash.

### `codex_auth_status`

Whether Codex is authenticated, in which mode, and whether that matches your
configured `auth.mode`. Never returns a credential.

### `codex_capabilities`

Diagnostic. What evidence this instance can reach, which downstream tools were
withheld and why, and an explicit list of what the reviewer is forbidden to do.

---

## CLI

```bash
codex-mcp init         # write ~/.config/codex-mcp/, detecting local MCP servers
codex-mcp start        # run the MCP server on stdio (what a client launches)
codex-mcp login        # authenticate (--mode chatgpt|api)
codex-mcp auth-status  # report auth state, never credentials
codex-mcp doctor       # diagnose everything; mutates nothing
```

`init` takes `--model <id>`, `--force`, and `--dry-run`. `start` and `doctor`
take `--config <path>`. `doctor` also takes `--project <path>` and `--json`.

`codex-mcp broker` is internal — the evidence broker that Codex launches. You do
not run it by hand.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/mcp` does not list codex-mcp | Client not restarted, or `.mcp.json` sitting in `.claude/` | Restart; move the file to the project root |
| `env` in `.mcp.json` has no effect | A `claude mcp add` registration outranks it | `claude mcp remove codex-mcp` |
| `CODEX_AUTH_REQUIRED` | Not signed in | `codex-mcp login` |
| `CODEX_MODEL_NOT_AVAILABLE` | Codex CLI too old, or the model is not on your account | `npm i -g @openai/codex@latest`, or pick another model |
| `CODEX_NOT_INSTALLED` | Codex CLI missing from `PATH` | `npm i -g @openai/codex@latest` |
| `Could not execute codex: spawn codex ENOENT` on Windows, with `codex` working in your shell | You are on a build from before Windows launcher resolution | Update and rebuild; see [Windows](#windows) |
| Auth-mode mismatch error | `auth.mode` disagrees with how the CLI is signed in | Change one to match; do not silently bill the wrong account |
| Connector missing from `doctor` | `enabled: false`, or no `command`/`url` | Check the YAML; `doctor` names the reason |
| Connector skipped mid-review | Your client cannot show elicitation prompts | Set `approval: trusted` on it |
| `codex-mcp: command not found` after an nvm switch | `npm link` is scoped to one Node version | Re-run `npm link` under the version you use |
| Config edits do nothing | An environment variable outranks the file | `codex-mcp doctor` prints the winner and warns on model conflicts |

Everything `doctor` reports is either `ok`, `warn` (works, but looser than it
should be), or `FAIL` (reviews cannot work).

---

## Errors

Stable codes, safe to branch on. Payloads are redacted before they leave the
process.

```text
CODEX_AUTH_REQUIRED              CODEX_NOT_INSTALLED
CODEX_MODEL_NOT_CONFIGURED       CODEX_MODEL_NOT_AVAILABLE
INVALID_PROJECT_ROOT             PROJECT_ACCESS_DENIED
INVALID_REVIEW_REQUEST           INVALID_REVIEW_TYPE
DOWNSTREAM_MCP_UNAVAILABLE       DOWNSTREAM_MCP_PERMISSION_DENIED
DB_QUERY_DENIED                  DB_QUERY_TIMEOUT
CODEX_EXECUTION_FAILED           CODEX_OUTPUT_INVALID
REVIEW_TIMEOUT                   INTERNAL_ERROR
```

If Codex returns output that does not match the schema, `codex-mcp` retries
**once** with an explicit correction that forbids re-analysis. If that also
fails it returns `CODEX_OUTPUT_INVALID`. It does not return a partially parsed
review — you would act on it.

---

## Observability

Structured JSON to **stderr** (stdout belongs to the MCP transport). Logged:
review id and type, hashed project id, model, timings, connector availability,
candidate counts, Codex exit status, schema-validation status.

Never logged: tokens, passwords, DB credentials, cookies, secrets found in
source. Redaction runs at every level, including `debug`.

---

## Testing

Five layers, cheapest first. Work down them — a failure at one layer makes the
next layer's result meaningless.

### 1. Automated suite — free, offline, ~7s

```bash
npm install
npm run build
npm test
npm run typecheck
```

400+ tests against a fake Codex CLI and a deliberately hostile fake MCP server.
No network, no model calls, deterministic. This is what you run on every change
and in CI.

Green on Linux and macOS. On Windows the spawn and launcher layers pass, but
ten tests still fail on path handling — `~` expansion, `HOME`-derived config
discovery, and project-root containment all assume POSIX separators. Those are
assertions about paths, not about behaviour under review; the server itself
runs correctly on Windows.

`tests/security/` is the part worth reading: it asserts that file edits,
commits, pushes, issue writes, and DB mutations are refused — and that a refused
call never reaches the downstream server.

### 2. `doctor` — is this install wired up correctly

```bash
codex-mcp doctor
codex-mcp doctor --project /path/to/repo
```

Read-only, safe against a live project. Checks Node, the Codex CLI, auth, auth
*mode* agreement, model, sandbox, config file, and every configured connector.

### 3. `codex_capabilities` — which evidence can it actually reach

`doctor` gives counts; this gives the per-tool breakdown, including *why* each
withheld tool was withheld. Call it from your MCP client, or:

```bash
node -e "
import('./dist/src/config/config.js').then(async ({loadConfig}) => {
  const {CodexMcpServer} = await import('./dist/src/server.js');
  const {Logger} = await import('./dist/src/util/logger.js');
  const s = new CodexMcpServer({config: loadConfig(), logger: new Logger('error', {}, {write(){}})});
  console.log(JSON.stringify(await s.callToolForTesting('codex_capabilities', {}), null, 2));
  process.exit(0);
});"
```

Check that the tools you expect are in `allowedTools`, and that every entry in
`deniedTools` is one you *want* denied. A read-only tool with an unusual name
lands in `deniedTools` as `unknown` — add it to that connector's `allowTools`.

### 4. `npm run try` — a real review, real model, real cost

This is the only layer that spends budget. It proves the whole path: auth,
model, sandbox, evidence collection, connectors, prompt, structured output.

```bash
npm run try -- --project /path/to/repo
npm run try -- --project /path/to/repo --type bugs
npm run try -- --project /path/to/repo --type combined --task DEV-123
npm run try -- --project /path/to/repo --candidates ./candidates.json --json
```

With no `--candidates` it sends a set seeded with **known flaws** — two
duplicates, one assertion the code contradicts, and several obvious gaps. That
is the point: you are testing the reviewer, so use input whose correct answer
you already know.

Judge it on:

- did it put the duplicate in `remove`?
- did it put the contradicted assertion in `modify`, citing the code?
- does every `missing` entry have a real `file:line`, not a vague area?
- is the repository unchanged afterwards (`git status`)?

**A `PASS` on the seeded set means something is wrong**, not that your code is
clean.

Supply `--candidates` with your own JSON to rehearse a real workflow:

```json
{ "testCases": [{ "id": "TC-1", "title": "..." }], "bugs": [] }
```

### 5. End-to-end fixture — opt-in

```bash
CODEX_MCP_E2E=1 npm test -- tests/e2e
```

Builds a fixture repository containing a real coverage gap (idempotency) and a
bug report that router middleware already refutes, runs a full qualification
against the real Codex CLI, and asserts the fixture is byte-identical
afterwards. Takes a few minutes.

### Driving it as an MCP server

Once the layers above pass, drive it the way a client will:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | codex-mcp start
```

Then register it in Claude Code and use it on a real ticket.

---

## Development

```text
src/
  config/      resolution, precedence, validation
  auth/        Codex CLI delegation for both auth modes
  codex/       process spawning, argv construction, output parsing
  review/      orchestration, per-type reviewers, output normalization
  evidence/    repository, git, artifacts, requirement, database, external
  mcp-broker/  downstream clients, discovery, classification, the broker server
  policy/      command, SQL, MCP-tool, permission, and consent decisions
  prompts/     base reviewer, test-design, bug-review
  schemas/     public request and result contracts
  tools/       the three MCP tools
```

---

## Known limitations

Deferred rather than hidden:

- **No stateful continuation.** `maxPasses` defaults to `1` because a second
  pass has no memory of the first. Multi-pass review needs a request carrying
  `reviewId`, `previousFindings`, `authorResponses`, and `revisedCandidate`.
- **Read scope is not confined to the project.** See
  [read scope](#read-scope-is-wider-than-the-project). A container or VM with
  only the project mounted is the only reliable bound today.
- **Assembled prompts are large** — roughly 4.8k tokens for test-design and
  5.4k for bug-review, before evidence. Nearly all of it is the coverage
  dimensions and discovery checks, which are the substance of the review.

---

## License

MIT

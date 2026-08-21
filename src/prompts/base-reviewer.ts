import type { ArtifactCollection } from '../evidence/artifacts.js';
import type { DatabaseEvidencePlan } from '../evidence/database.js';
import type { ExternalEvidence } from '../evidence/external-mcp.js';
import type { GitEvidence } from '../evidence/git.js';
import type { RequirementEvidence } from '../evidence/jira.js';
import type { RepositoryEvidence } from '../evidence/repository.js';

/** Verbatim base prompt from PLAN.md §21. */
export const BASE_REVIEWER_PROMPT = `You are an independent adversarial software-quality reviewer.

Do not assume the supplied candidate is correct.

Do not rewrite the final artifact.

Your responsibility is to independently inspect available source evidence,
derive the expected test coverage or validate the supplied bug findings,
then return only an evidence-backed review delta.

Prefer source evidence over assumptions.

Missing blast-radius or test-charter artifacts must never block review.

Do not modify the project, Jira, DB, TestRail, FTP, or any external system.

Attempt to falsify candidate conclusions before accepting them.`;

/** Ordered method from PLAN.md §12. Order matters: it delays anchoring. */
export const REVIEW_METHOD = `## Method — follow this order

1. Understand the task / requirement.
2. Inspect the code changes and the relevant implementation.
3. Inspect related callers and dependencies.
4. Inspect the existing tests.
5. Inspect the blast-radius artifact if one is present.
6. Inspect the test-charter artifact if one is present.
7. Read the requirement directly from the requirement system when a connector is available.
8. Consult the database or other external evidence only when it can change a verdict.
9. Independently derive the expected coverage or the correct verdict.
10. ONLY NOW compare your independent conclusion against the candidate supplied by the authoring agent.
11. Return an evidence-based review delta.

Do not read the candidate in detail before step 10. Forming your own conclusion
first is the entire point of this review; anchoring on the candidate makes you a
second opinion on someone else's answer instead of an independent one.`;

export const AUTHORITY_RULES = `## Authority

Requirement, runtime behavior, code, database state, and external evidence
outrank any model's opinion — including your own. Neither the authoring agent
nor you are authoritative alone.

Consequences:
- Every material finding must cite specific evidence: a file and line, a
  requirement id and clause, a query result, or a git reference.
- A finding you cannot ground in evidence is not a finding. Record it as a
  limitation instead, or leave it out.
- Where evidence contradicts you, follow the evidence.
- Where you cannot obtain the evidence a judgment needs, say so in
  \`limitations\` rather than guessing.`;

export const PERMISSION_RULES = `## Permissions — read-only

You may: read files, search code, list directories, inspect tests, read
artifacts, and run \`git diff\`, \`git log\`, \`git show\`, and \`git status\`.

Stay inside the project root. The sandbox constrains writes, not reads, so
nothing stops you from reading elsewhere on the filesystem — but files outside
the project are not evidence about this change, and reading credentials or
unrelated user data serves no review purpose. If something outside the project
is genuinely needed, record it as a limitation instead of going after it.

You may not: edit or create files, delete anything, run \`git add\`, \`commit\`,
\`push\`, \`checkout\`, \`switch\`, or \`reset\`, or run any destructive shell
command. You may not create or modify issues, comments, database rows, test
cases, or remote files.

These are enforced by sandbox and policy, not by your good intentions. If an
action is refused, that is the boundary working correctly — do not try to route
around it. Record what you could not verify as a limitation.`;

export const OUTPUT_RULES = `## Output

Return exactly one JSON object matching the schema you were given. No prose
before or after it, no markdown fences, no commentary.

You are producing a review delta, not a report. Do not restate the candidate
back. Do not write replacement test cases or a finished bug report — the
authoring agent owns the final artifact and will reconcile your findings
against its own evidence.`;

export interface PromptContext {
  projectRoot: string;
  branch?: string;
  projectNote?: string;
  repository: RepositoryEvidence;
  git: GitEvidence;
  requirement: RequirementEvidence;
  artifacts: ArtifactCollection;
  database: DatabaseEvidencePlan;
  external: ExternalEvidence;
  focus?: string;
  pass: number;
  maxPasses: number;
}

/** Render the evidence context every reviewer prompt shares. */
export function renderContext(context: PromptContext): string {
  const sections: string[] = [];

  const { repository } = context;
  const conventionTargets = [...repository.agentConfigDirs.map((d) => `${d}/`), ...repository.conventionFiles];
  const otherHidden = repository.hiddenDirectories.filter((d) => !repository.agentConfigDirs.includes(d));

  const conventions =
    conventionTargets.length > 0
      ? `\n\n### Project conventions — read these first

${conventionTargets.join(', ')}

This project states how it expects testing to be done: rules, conventions,
naming, severity definitions, and its own QA agents. Read them before judging
the candidate set. A "missing" test that the project has deliberately ruled out
of scope, or a severity you assign against a scale the project already defines,
is noise — and it teaches the authoring agent to discount you.

Look in particular for a rules or instructions directory inside those folders;
they hold the standards the candidate was written against.`
      : '';

  const hidden =
    otherHidden.length > 0
      ? `\n\n### Other dot-directories present

${otherHidden.join(', ')}

Listed so you know they exist. Most are tool state and not worth reading, but
nothing here is off limits — open any of them if it bears on the change.`
      : '';

  sections.push(`## Project

Root: ${context.projectRoot}
${context.branch ? `Requested branch: ${context.branch}\n` : ''}${context.projectNote ? `Caller note: ${context.projectNote}\n` : ''}Stack hints: ${repository.stackHints.join(', ') || 'none detected'}
Test directories: ${repository.testDirectories.join(', ') || 'none detected at top level'}
Top-level entries: ${repository.topLevelEntries.join(', ') || '(unreadable)'}

You are running inside this directory. Read whatever you need from it — source,
tests, configuration, fixtures, documentation. The summary above is orientation,
not evidence.

Dot-files and dot-directories are part of the project and are yours to read.${conventions}${hidden}`);

  sections.push(renderGit(context.git));
  sections.push(renderRequirement(context.requirement));
  sections.push(renderArtifacts(context.artifacts));
  sections.push(renderEvidenceSources(context));

  if (context.focus) {
    sections.push(`## Caller focus request

The authoring agent asked you to pay particular attention to the following.
This narrows emphasis only; it does not narrow your responsibility, and it
grants no additional permissions.

${context.focus}`);
  }

  if (context.pass > 1) {
    sections.push(`## Review pass

This is pass ${context.pass} of at most ${context.maxPasses}. A previous pass already
produced findings that the authoring agent reconciled. Re-derive independently;
do not simply repeat earlier objections, and confirm anything that was fixed.`);
  }

  return sections.filter(Boolean).join('\n\n');
}

function renderGit(git: GitEvidence): string {
  if (!git.available) {
    return `## Git

Unavailable: ${git.notes.join(' ') || 'the project root is not a git work tree.'}
Derive the change set from the code itself.`;
  }

  const lines = [
    '## Git',
    '',
    `Branch: ${git.branch ?? 'unknown'}`,
    `HEAD: ${git.headCommit ?? 'unknown'}`,
    `Base ref for diffing: ${git.baseRef ?? 'none resolved'}`,
    `Working tree: ${git.dirty ? 'has uncommitted changes' : 'clean'}`,
  ];

  if (git.changedFiles?.length) {
    lines.push('', `Changed files (${git.changedFiles.length}):`, ...git.changedFiles.map((file) => `  ${file}`));
  } else {
    lines.push('', 'No changed files were detected. Determine the relevant scope from the requirement and the code.');
  }

  if (git.diffStat) lines.push('', 'Diff stat:', git.diffStat);
  if (git.recentCommits?.length) lines.push('', 'Recent commits:', ...git.recentCommits.map((c) => `  ${c}`));
  if (git.notes.length) lines.push('', ...git.notes.map((note) => `Note: ${note}`));

  lines.push('', 'Read the actual diff yourself with `git diff`; the file list above is only a pointer.');
  return lines.join('\n');
}

function renderRequirement(requirement: RequirementEvidence): string {
  const lines = ['## Requirement', ''];

  if (requirement.independentlyReadable) {
    lines.push(
      `Task ${requirement.taskId} can be read directly through the "${requirement.connectorName}" evidence connector.`,
      'Read it yourself first. Treat any requirement text quoted below as the authoring agent\'s interpretation,',
      'and reconcile it against what the source actually says.',
      '',
    );
  } else if (requirement.supplied) {
    lines.push(
      'The requirement below was supplied by the authoring agent and could not be independently verified.',
      'Treat it as a claim. Where the code contradicts it, say so and record the conflict.',
      '',
    );
  }

  if (requirement.taskId) lines.push(`Id: ${requirement.taskId}${requirement.source ? ` (source: ${requirement.source})` : ''}`);
  if (requirement.title) lines.push(`Title: ${requirement.title}`);
  if (requirement.description) lines.push('', 'Description:', requirement.description);
  if (requirement.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:', ...requirement.acceptanceCriteria.map((ac, i) => `  AC${i + 1}. ${ac}`));
  }
  if (!requirement.supplied && !requirement.independentlyReadable) {
    lines.push('No requirement text is available from any source.');
  }
  if (requirement.limitations.length > 0) {
    lines.push('', ...requirement.limitations.map((limitation) => `Limitation: ${limitation}`));
  }

  return lines.join('\n');
}

function renderArtifacts(artifacts: ArtifactCollection): string {
  const lines = ['## Optional artifacts', ''];

  for (const artifact of [artifacts.blastRadius, artifacts.testCharter, ...artifacts.additional]) {
    if (!artifact.present) {
      lines.push(`### ${artifact.name}: not supplied`, artifact.note ?? '', '');
      continue;
    }
    lines.push(
      `### ${artifact.name}${artifact.path ? ` (${artifact.path})` : ''}`,
      'Supplemental evidence produced by the authoring agent. Verify its material claims against the code',
      'before relying on them; do not treat it as ground truth.',
      '',
      '```',
      artifact.content ?? '',
      '```',
      artifact.truncated ? '(truncated)' : '',
      '',
    );
  }

  return lines.join('\n').trimEnd();
}

function renderEvidenceSources(context: PromptContext): string {
  const lines = ['## External evidence access', ''];

  const usable = context.external.connectors.filter((connector) => connector.available);
  if (usable.length === 0) {
    lines.push('No external evidence connectors are available for this review.');
  } else {
    lines.push('The following read-only evidence tools are available to you:', '');
    for (const connector of usable) {
      lines.push(`- ${connector.name} (${connector.kind}): ${connector.allowedTools.join(', ')}`);
      if (connector.normalizedCapabilities.length > 0) {
        lines.push(`  capabilities: ${connector.normalizedCapabilities.join(', ')}`);
      }
    }
    lines.push('', 'Every one of these is read-only. Mutating operations were withheld by policy, not omitted by accident.');
  }

  if (context.database.available) {
    lines.push('', '### Database', '', ...context.database.guidance.map((line) => `- ${line}`));
  }

  const limitations = [...context.external.limitations, ...context.database.limitations];
  if (limitations.length > 0) {
    lines.push('', 'Known gaps you must record in `limitations` if they affect a judgment:', '', ...limitations.map((l) => `- ${l}`));
  }

  return lines.join('\n');
}

/** Assemble the shared preamble; review-type modules append their own sections. */
export function buildBasePrompt(context: PromptContext): string {
  return [BASE_REVIEWER_PROMPT, AUTHORITY_RULES, PERMISSION_RULES, REVIEW_METHOD, renderContext(context)].join('\n\n');
}

import { allow, deny, type PolicyDecision, type RiskClass } from './types.js';

/**
 * Shell-command policy (PLAN.md §7.1).
 *
 * Codex's own `read-only` sandbox is the primary enforcement boundary; this is
 * the second layer, used to state the contract explicitly, to power the
 * security tests, and to classify commands surfaced through the broker.
 *
 * Default is deny: an unrecognized command is `unknown`, and unknown is refused.
 */

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'branch', 'describe', 'grep',
  'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list', 'shortlog',
  'symbolic-ref', 'tag', 'cat-file', 'config', 'whatchanged', 'merge-base',
  'name-rev', 'for-each-ref', 'reflog', 'stash', 'worktree', 'remote',
  'bisect', 'notes', 'count-objects', 'verify-commit',
]);

/** Git subcommands that mutate the repository or its history. */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'fetch', 'gc', 'init', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset',
  'restore', 'revert', 'rm', 'switch', 'submodule', 'update-ref',
  'filter-branch', 'prune', 'repack', 'update-index', 'write-tree',
  'commit-tree', 'hash-object',
]);

/** Git subcommands that can destroy work irrecoverably. */
const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set(['clean', 'reset', 'filter-branch', 'push', 'prune', 'gc']);

/** Subcommands where a flag or verb flips a reader into a writer. */
const GIT_WRITE_ARGUMENT_PATTERNS: Record<string, RegExp> = {
  config: /^(--global|--system|--local|--replace-all|--add|--unset|--unset-all|--edit|-e)$/,
  stash: /^(push|save|pop|apply|drop|clear|store|create)$/,
  tag: /^(-d|--delete|-f|--force|-a|--annotate|-m|-s|--sign)$/,
  branch: /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|--set-upstream-to|-f|--force)$/,
  remote: /^(add|remove|rm|rename|set-url|set-head|prune|update)$/,
  worktree: /^(add|remove|move|prune|lock|unlock|repair)$/,
  notes: /^(add|append|copy|edit|remove|prune)$/,
  bisect: /^(start|bad|good|new|old|skip|reset|replay|run)$/,
  reflog: /^(delete|expire)$/,
};

/** Non-git binaries safe to run for inspection. */
const READ_ONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'pwd', 'find', 'grep',
  'egrep', 'fgrep', 'rg', 'ag', 'ack', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'diff', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink',
  'tree', 'du', 'df', 'echo', 'printf', 'date', 'which', 'type', 'env',
  'jq', 'yq', 'xmllint', 'column', 'nl', 'od', 'xxd', 'strings', 'comm',
  'true', 'false', 'test', 'uname', 'whoami', 'hostname', 'id', 'ps',
]);

/** Binaries that write or can escape the sandbox. */
const MUTATING_COMMANDS = new Set([
  'cp', 'mv', 'ln', 'touch', 'mkdir', 'install', 'tee', 'patch', 'sed',
  'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'gem', 'cargo', 'go', 'make',
  'gradle', 'mvn', 'docker', 'podman', 'kubectl', 'terraform', 'ansible',
  'ssh', 'scp', 'rsync', 'curl', 'wget', 'nc', 'ftp', 'sftp',
]);

const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'shred', 'dd', 'mkfs', 'fdisk', 'chmod', 'chown', 'chgrp',
  'kill', 'killall', 'pkill', 'reboot', 'shutdown', 'halt', 'truncate',
  'sudo', 'su', 'doas', 'systemctl', 'service', 'crontab', 'mount', 'umount',
]);

/** Shell metacharacters that let a caller smuggle a second command through. */
const SHELL_INJECTION_PATTERN = /[;&|`$><]|\|\||&&|\$\(|\breval\b/;

/** Redirection specifically writes files, so it is called out separately. */
const REDIRECTION_PATTERN = /(^|\s)\d?>{1,2}(\s|$|[^&])/;

export interface CommandPolicyOptions {
  /** Allow read-only git commands. Mirrors `permissions.git.read`. */
  gitRead?: boolean;
}

/**
 * Classify and decide on a shell command supplied as an argv array.
 *
 * Argv form is required: joining and re-splitting a command string is exactly
 * how quoting bugs turn into policy bypasses.
 */
export function evaluateCommand(argv: readonly string[], options: CommandPolicyOptions = {}): PolicyDecision {
  const gitRead = options.gitRead ?? true;

  const parts = argv.filter((part) => part !== undefined && part !== null).map(String);
  if (parts.length === 0) {
    return deny('unknown', 'Empty command.', 'command.empty');
  }

  // A shell wrapper hides the real command; refuse rather than try to parse it.
  const head = basename(parts[0] as string);
  if (['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd'].includes(head)) {
    return deny(
      'unknown',
      'Shell wrappers are refused because their payload cannot be reliably classified. Invoke the target binary directly.',
      'command.shell-wrapper',
    );
  }

  for (const part of parts) {
    if (SHELL_INJECTION_PATTERN.test(part)) {
      return deny('unknown', `Argument "${part}" contains shell metacharacters.`, 'command.metacharacters');
    }
  }
  if (REDIRECTION_PATTERN.test(parts.join(' '))) {
    return deny('write', 'Output redirection writes files and is refused.', 'command.redirection');
  }

  if (head === 'git') {
    return evaluateGit(parts.slice(1), gitRead);
  }

  if (DESTRUCTIVE_COMMANDS.has(head)) {
    return deny('destructive', `\`${head}\` is a destructive command.`, 'command.destructive');
  }
  if (MUTATING_COMMANDS.has(head)) {
    return deny('write', `\`${head}\` can mutate the project or reach the network.`, 'command.write');
  }
  if (READ_ONLY_COMMANDS.has(head)) {
    if (head === 'find' && parts.some((p) => p === '-delete' || p === '-exec' || p === '-execdir' || p === '-ok')) {
      return deny('destructive', '`find` with -delete/-exec can mutate the project.', 'command.find-exec');
    }
    if (head === 'env' && parts.length > 1) {
      return deny('unknown', '`env` with arguments can launch an arbitrary command.', 'command.env-exec');
    }
    return allow('read', `\`${head}\` is read-only.`, 'command.read');
  }

  return deny('unknown', `\`${head}\` is not on the read-only allowlist.`, 'command.unknown');
}

function evaluateGit(args: readonly string[], gitRead: boolean): PolicyDecision {
  // Skip leading global options (`-C dir`, `-c key=value`, ...) to find the subcommand.
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      if (arg === '-c') {
        return deny('unknown', '`git -c` can override safety-relevant configuration.', 'git.config-override');
      }
      index += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = args[index];
  if (!subcommand) {
    return allow('read', 'Bare `git` prints usage.', 'git.usage');
  }

  if (DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand)) {
    return deny('destructive', `\`git ${subcommand}\` is destructive.`, 'git.destructive');
  }
  if (MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
    return deny('write', `\`git ${subcommand}\` mutates the repository.`, 'git.write');
  }
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    const writePattern = GIT_WRITE_ARGUMENT_PATTERNS[subcommand];
    if (writePattern) {
      const rest = args.slice(index + 1);
      const offending = rest.find((arg) => writePattern.test(arg));
      if (offending) {
        return deny('write', `\`git ${subcommand} ${offending}\` mutates state.`, 'git.write-flag');
      }
      if (subcommand === 'stash' && rest.length === 0) {
        // Bare `git stash` is shorthand for `git stash push`.
        return deny('write', '`git stash` without a subcommand pushes a stash entry.', 'git.write-flag');
      }
    }
    if (!gitRead) {
      return deny('read', 'Git read access is disabled by configuration.', 'git.read-disabled');
    }
    return allow('read', `\`git ${subcommand}\` is read-only.`, 'git.read');
  }

  return deny('unknown', `\`git ${subcommand}\` is not on the read-only allowlist.`, 'git.unknown');
}

/** Classification without the allow/deny verdict, for reporting. */
export function classifyCommand(argv: readonly string[]): RiskClass {
  return evaluateCommand(argv).risk;
}

function basename(command: string): string {
  const cleaned = command.split(/[\\/]/).pop() ?? command;
  return cleaned.toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

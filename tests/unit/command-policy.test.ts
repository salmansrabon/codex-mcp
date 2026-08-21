import { describe, expect, it } from 'vitest';

import { classifyCommand, evaluateCommand } from '../../src/policy/command-policy.js';

const allowed = (argv: string[]): boolean => evaluateCommand(argv).effect === 'allow';

describe('read-only git commands', () => {
  it.each([
    ['git', 'diff'],
    ['git', 'diff', '--stat', 'main...HEAD'],
    ['git', 'log', '-n', '10'],
    ['git', 'show', 'HEAD'],
    ['git', 'status', '--porcelain'],
    ['git', 'blame', 'src/app.ts'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'merge-base', 'main', 'HEAD'],
  ])('allows %s %s', (...argv) => {
    expect(allowed(argv)).toBe(true);
  });
});

describe('mutating git commands', () => {
  it.each([
    ['git', 'add', '.'],
    ['git', 'commit', '-m', 'msg'],
    ['git', 'push'],
    ['git', 'checkout', 'main'],
    ['git', 'switch', 'main'],
    ['git', 'reset', '--hard'],
    ['git', 'clean', '-fd'],
    ['git', 'apply', 'patch.diff'],
    ['git', 'rm', 'file.ts'],
    ['git', 'restore', 'file.ts'],
  ])('denies %s %s', (...argv) => {
    expect(allowed(argv)).toBe(false);
  });

  it('classifies history-destroying commands as destructive', () => {
    expect(classifyCommand(['git', 'reset', '--hard'])).toBe('destructive');
    expect(classifyCommand(['git', 'clean', '-fdx'])).toBe('destructive');
    expect(classifyCommand(['git', 'push', '--force'])).toBe('destructive');
  });
});

describe('git subcommands where a flag flips read to write', () => {
  it('allows plain listing but denies mutation', () => {
    expect(allowed(['git', 'branch'])).toBe(true);
    expect(allowed(['git', 'branch', '-D', 'feature'])).toBe(false);
    expect(allowed(['git', 'tag'])).toBe(true);
    expect(allowed(['git', 'tag', '-d', 'v1'])).toBe(false);
    expect(allowed(['git', 'remote'])).toBe(true);
    expect(allowed(['git', 'remote', 'add', 'x', 'url'])).toBe(false);
  });

  it('reads config but refuses to write it', () => {
    expect(allowed(['git', 'config', 'user.name'])).toBe(true);
    expect(allowed(['git', 'config', '--global', 'user.name', 'x'])).toBe(false);
  });

  it('treats bare `git stash` as the write it actually is', () => {
    expect(allowed(['git', 'stash'])).toBe(false);
    expect(allowed(['git', 'stash', 'list'])).toBe(true);
  });

  it('refuses `git -c` config overrides', () => {
    expect(allowed(['git', '-c', 'core.pager=sh', 'log'])).toBe(false);
  });
});

describe('non-git commands', () => {
  it('allows plain readers', () => {
    expect(allowed(['cat', 'README.md'])).toBe(true);
    expect(allowed(['rg', 'pattern', 'src'])).toBe(true);
    expect(allowed(['ls', '-la'])).toBe(true);
  });

  it('denies writers and destructive binaries', () => {
    expect(allowed(['rm', '-rf', 'src'])).toBe(false);
    expect(allowed(['cp', 'a', 'b'])).toBe(false);
    expect(allowed(['npm', 'install'])).toBe(false);
    expect(allowed(['curl', 'https://example.com'])).toBe(false);
    expect(allowed(['sudo', 'ls'])).toBe(false);
    expect(allowed(['chmod', '777', 'file'])).toBe(false);
  });

  it('denies find with -exec or -delete', () => {
    expect(allowed(['find', '.', '-name', '*.ts'])).toBe(true);
    expect(allowed(['find', '.', '-name', '*.ts', '-delete'])).toBe(false);
    expect(allowed(['find', '.', '-exec', 'rm', '{}', '+'])).toBe(false);
  });
});

describe('injection and wrapper defenses', () => {
  it('refuses shell wrappers whose payload cannot be classified', () => {
    expect(allowed(['bash', '-c', 'git status'])).toBe(false);
    expect(allowed(['sh', '-c', 'ls'])).toBe(false);
  });

  it('refuses arguments carrying shell metacharacters', () => {
    expect(allowed(['git', 'log', '--pretty=$(rm -rf /)'])).toBe(false);
    expect(allowed(['cat', 'a.txt;rm b.txt'])).toBe(false);
    expect(allowed(['grep', 'x', 'f', '&&', 'rm', 'f'])).toBe(false);
  });

  it('refuses output redirection', () => {
    expect(allowed(['cat', 'a', '>', 'b'])).toBe(false);
  });

  it('refuses `env` used as a launcher', () => {
    expect(allowed(['env'])).toBe(true);
    expect(allowed(['env', 'rm', '-rf', '/'])).toBe(false);
  });

  it('defaults unknown binaries to deny', () => {
    const decision = evaluateCommand(['some-unfamiliar-binary', '--flag']);
    expect(decision.effect).toBe('deny');
    expect(decision.risk).toBe('unknown');
  });

  it('refuses an empty command', () => {
    expect(evaluateCommand([]).effect).toBe('deny');
  });

  it('is not fooled by an absolute path or .exe suffix', () => {
    expect(allowed(['/usr/bin/rm', 'file'])).toBe(false);
    expect(allowed(['C:\\Windows\\System32\\cmd.exe', '/c', 'dir'])).toBe(false);
  });
});

describe('gitRead permission', () => {
  it('denies read-only git when git read access is turned off', () => {
    expect(evaluateCommand(['git', 'log'], { gitRead: false }).effect).toBe('deny');
    expect(evaluateCommand(['cat', 'file'], { gitRead: false }).effect).toBe('allow');
  });
});

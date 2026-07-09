import { describe, it, expect } from 'vitest';
import { isReadOnlyBashCommand } from '../safe-bash';

describe('isReadOnlyBashCommand', () => {
  it('accepts observe-only commands', () => {
    expect(isReadOnlyBashCommand('ls -la')).toBe(true);
    expect(isReadOnlyBashCommand('pwd')).toBe(true);
    expect(isReadOnlyBashCommand('cat package.json')).toBe(true);
    expect(isReadOnlyBashCommand('wc -l src/main.ts')).toBe(true);
    expect(isReadOnlyBashCommand('grep -rn "todo" src')).toBe(true);
    expect(isReadOnlyBashCommand('echo hi')).toBe(true);
    expect(isReadOnlyBashCommand('jq .name package.json')).toBe(true);
  });

  it('accepts pipelines when every link is safe', () => {
    expect(isReadOnlyBashCommand('grep -r foo src | head -20')).toBe(true);
    expect(isReadOnlyBashCommand('cat a.txt | wc -l')).toBe(true);
  });

  it('accepts read-only git subcommands with any flags', () => {
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('git log --oneline -5')).toBe(true);
    expect(isReadOnlyBashCommand('git diff HEAD~1')).toBe(true);
    expect(isReadOnlyBashCommand('git show abc123')).toBe(true);
    expect(isReadOnlyBashCommand('git rev-parse HEAD')).toBe(true);
  });

  it('rejects mutating or ambiguous git invocations', () => {
    expect(isReadOnlyBashCommand('git push origin main')).toBe(false);
    expect(isReadOnlyBashCommand('git commit -m x')).toBe(false);
    expect(isReadOnlyBashCommand('git checkout .')).toBe(false);
    expect(isReadOnlyBashCommand('git branch foo')).toBe(false);
    // -C's argument reads as the subcommand — conservative miss, prompts.
    expect(isReadOnlyBashCommand('git -C /tmp status')).toBe(false);
  });

  it('rejects unknown or mutating programs', () => {
    expect(isReadOnlyBashCommand('npm run build')).toBe(false);
    expect(isReadOnlyBashCommand('rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('touch a')).toBe(false);
    expect(isReadOnlyBashCommand('sed -i s/a/b/ f')).toBe(false);
    expect(isReadOnlyBashCommand('node -e "code"')).toBe(false);
  });

  it('rejects a chain when any link is unsafe', () => {
    expect(isReadOnlyBashCommand('ls && rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('cat a | sh')).toBe(false);
  });

  it('rejects output redirection but tolerates quoted > characters', () => {
    expect(isReadOnlyBashCommand('echo hi > file')).toBe(false);
    expect(isReadOnlyBashCommand('cat a >> b')).toBe(false);
    expect(isReadOnlyBashCommand('ls 2>err')).toBe(false);
    expect(isReadOnlyBashCommand("grep '>' index.html")).toBe(true);
  });

  it('rejects process substitution (it executes a nested command)', () => {
    expect(isReadOnlyBashCommand('diff <(ls a) <(ls b)')).toBe(false);
  });

  it('gates command substitutions like any other subcommand', () => {
    expect(isReadOnlyBashCommand('echo $(pwd)')).toBe(true);
    expect(isReadOnlyBashCommand('echo $(rm -rf x)')).toBe(false);
    expect(isReadOnlyBashCommand('echo `whoami`')).toBe(true);
  });

  it('rejects credential-path arguments even for safe programs', () => {
    expect(isReadOnlyBashCommand('cat ~/.ssh/id_rsa')).toBe(false);
    expect(isReadOnlyBashCommand('cat .env')).toBe(false);
    expect(isReadOnlyBashCommand('grep key ~/.aws/credentials')).toBe(false);
    expect(isReadOnlyBashCommand('cat cert.pem')).toBe(false);
    expect(isReadOnlyBashCommand('cat ~/.config/gh/hosts.yml')).toBe(false);
  });

  it('rejects find with delete/exec flags but accepts plain find', () => {
    expect(isReadOnlyBashCommand('find . -name "*.ts"')).toBe(true);
    expect(isReadOnlyBashCommand('find . -delete')).toBe(false);
    expect(isReadOnlyBashCommand('find . -exec rm {} +')).toBe(false);
  });

  it('rejects an empty command', () => {
    expect(isReadOnlyBashCommand('   ')).toBe(false);
  });
});

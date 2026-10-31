import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fillPlaceholders,
  findWorkflowFiles,
  parseWorkflow,
  PROJECT_WORKFLOWS_DIR,
  readWorkflowFile,
  slugify,
  slugOf,
  targetOf,
  WorkflowFileError
} from '../config';
import { makeDef } from './helpers';

const VALID = `name = "Research"
shared = "Look into {{topic}}"

[[inputs]]
name = "topic"
label = "Topic"

[[agents]]
role = "Reader"
program = "pi"
prompt = "Read about {{topic}} for {{slug}}"

[judge]
role = "Writer"
program = "claude"
prompt = "Write it up."

[finish]
action = "save-report"
path = "docs/{{slug}}.md"
`;

function errorOf(text: string): string {
  try {
    parseWorkflow(text);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowFileError);
    return (err as Error).message;
  }
  throw new Error('The text parsed.');
}

/** The same text is in the renderer's workflow-toml.test.ts, which checks the form writes it. */
const EDITOR_FILE = `name = "Small"
shared = ""
board = true
workspace = "current"

[[inputs]]
name = "pr"
label = "Pull request"
type = "pr"
required = true

[[agents]]
role = "Reader"
program = "pi"
prompt = "Read it."

[judge]
role = "Judge"
program = "claude"
prompt = "Merge the findings."

[finish]
action = "save-report"
path = "out.md"
`;

describe('parseWorkflow', () => {
  it('accepts the text the form editor writes', () => {
    expect(parseWorkflow(EDITOR_FILE)).toEqual({
      name: 'Small',
      shared: '',
      board: true,
      workspace: 'current',
      inputs: [{ name: 'pr', label: 'Pull request', type: 'pr', required: true }],
      agents: [{ role: 'Reader', program: 'pi', prompt: 'Read it.' }],
      judge: { role: 'Judge', program: 'claude', prompt: 'Merge the findings.' },
      finish: { action: 'save-report', path: 'out.md' }
    });
  });

  it('parses a valid file and fills defaults', () => {
    const def = parseWorkflow(VALID);

    expect(def.name).toBe('Research');
    expect(def.board).toBe(true);
    expect(def.workspace).toBe('current');
    expect(def.inputs).toEqual([{ name: 'topic', label: 'Topic', type: 'text', required: true }]);
    expect(def.judge?.program).toBe('claude');
    expect(def.finish).toEqual({ action: 'save-report', path: 'docs/{{slug}}.md' });
  });

  it('refuses an unknown top-level key with its line', () => {
    const message = errorOf(
      `name = "A"\ncommand = "rm -rf /"\n\n[[agents]]\nrole = "R"\nprogram = "pi"\nprompt = "P"\n`
    );

    expect(message).toContain('command');
    expect(message).toContain('Line 2');
  });

  it('refuses a command key on an agent with its line', () => {
    const message = errorOf(
      `name = "A"\n\n[[agents]]\nrole = "R"\nprogram = "pi"\nprompt = "P"\ncommand = "ls"\n`
    );

    expect(message).toContain('command');
    expect(message).toContain('Line 7');
  });

  it('survives an unknown key full of regex characters', () => {
    const message = errorOf(
      `name = "A"\n"oops(" = 1\n\n[[agents]]\nrole = "R"\nprogram = "pi"\nprompt = "P"\n`
    );

    expect(message).toContain('oops(');
  });

  it('gives the line of a TOML syntax error', () => {
    expect(errorOf('name = "A"\nboard = = true\n')).toContain('Line 2');
  });

  it('gives the line of a bad value', () => {
    const message = errorOf(
      `name = "A"\n\n[[agents]]\nrole = "R"\nprogram = "bash"\nprompt = "P"\n`
    );

    expect(message).toContain('Line 5');
    expect(message).toContain('agents.0.program');
  });

  it('refuses a placeholder with no input', () => {
    const text = VALID.replace('Write it up.', 'Write about {{nothing}}.');

    expect(errorOf(text)).toContain('{{nothing}}');
  });

  it('refuses a file with no agents', () => {
    expect(errorOf('name = "A"\nagents = []\n')).toContain('agents');
  });

  it('refuses two agents with one role', () => {
    const text = VALID.replace('role = "Writer"', 'role = "Reader"');

    expect(errorOf(text)).toContain('same role');
  });

  it('needs one PR input for a PR worktree', () => {
    const text = VALID.replace('shared =', 'workspace = "pr-worktree"\nshared =');

    expect(errorOf(text)).toContain('exactly one input');
  });

  it('needs a PR worktree to post to a PR', () => {
    const text = VALID.replace('action = "save-report"', 'action = "post-pr"');

    expect(errorOf(text)).toContain('post-pr');
  });

  it('needs a report path that ends in .md', () => {
    expect(errorOf(VALID.replace('{{slug}}.md', '{{slug}}.txt'))).toContain('.md');
  });
});

describe('fillPlaceholders', () => {
  it('fills known names, with or without spaces', () => {
    expect(fillPlaceholders('{{a}} and {{ b }}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('leaves unknown names alone', () => {
    expect(fillPlaceholders('{{a}}', {})).toBe('{{a}}');
  });

  it('does not treat a value as a pattern or fill it again', () => {
    expect(fillPlaceholders('{{a}}', { a: '$& {{b}}', b: 'no' })).toBe('$& {{b}}');
  });
});

describe('slugify', () => {
  it('keeps a-z, 0-9 and dashes', () => {
    expect(slugify('  Fix the Bug: #12!  ')).toBe('fix-the-bug-12');
  });

  it('falls back to run', () => {
    expect(slugify('!!!')).toBe('run');
  });

  it('stops at 60 characters with no dash at the end', () => {
    const slug = slugify(`${'a'.repeat(59)} b`);

    expect(slug).toBe('a'.repeat(59));
  });
});

describe('slugOf and targetOf', () => {
  const prInput = { name: 'pr', label: 'PR', type: 'pr' as const, required: true };
  const textInput = { name: 'task', label: 'Task', type: 'text' as const, required: true };

  it('uses the PR number first', () => {
    const def = makeDef({ inputs: [textInput, prInput] });

    expect(slugOf(def, { pr: '12', task: 'Other' })).toBe('pr-12');
    expect(targetOf(def, { pr: '12', task: 'Other' })).toBe('pr:12');
  });

  it('uses the first text input with no PR', () => {
    const def = makeDef({ inputs: [textInput] });

    expect(slugOf(def, { task: 'Do This' })).toBe('do-this');
    expect(targetOf(def, { task: 'Do This' })).toBe('["Do This"]');
  });

  it('uses the workflow name with no inputs', () => {
    const def = makeDef({ name: 'My Flow' });

    expect(slugOf(def, {})).toBe('my-flow');
    expect(targetOf(def, {})).toBe('[]');
  });
});

describe('workflow files', () => {
  let dir: string;
  let project: string;
  let personal: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-config-'));
    project = join(dir, 'project');
    personal = join(dir, 'personal');
    mkdirSync(join(project, PROJECT_WORKFLOWS_DIR), { recursive: true });
    mkdirSync(personal);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lets a project file win over a personal one', () => {
    writeFileSync(join(project, PROJECT_WORKFLOWS_DIR, 'shared.toml'), VALID);
    writeFileSync(join(personal, 'shared.toml'), VALID);
    writeFileSync(join(personal, 'mine.toml'), VALID);
    writeFileSync(join(personal, 'notes.txt'), 'not a workflow');

    const { files, replaced } = findWorkflowFiles(project, personal);

    expect(files.map((file) => [file.id, file.scope])).toEqual([
      ['shared', 'project'],
      ['mine', 'personal']
    ]);
    expect([...replaced]).toEqual(['shared']);
  });

  it('copes with missing folders', () => {
    const { files, replaced } = findWorkflowFiles(join(dir, 'none'), join(dir, 'gone'));

    expect(files).toEqual([]);
    expect(replaced.size).toBe(0);
  });

  it('refuses a symlink', () => {
    const real = join(dir, 'real.toml');
    const link = join(dir, 'link.toml');
    writeFileSync(real, VALID);
    symlinkSync(real, link);

    expect(() => readWorkflowFile(link)).toThrow(WorkflowFileError);
  });

  it('refuses a file over the size limit', () => {
    const big = join(dir, 'big.toml');
    writeFileSync(big, 'a'.repeat(256 * 1024 + 1));

    expect(() => readWorkflowFile(big)).toThrow('too large');
  });

  it('hashes the bytes it read', () => {
    const path = join(dir, 'a.toml');
    writeFileSync(path, 'one');
    const first = readWorkflowFile(path);
    writeFileSync(path, 'two');
    const second = readWorkflowFile(path);

    expect(first.text).toBe('one');
    expect(first.hash).not.toBe(second.hash);
  });
});

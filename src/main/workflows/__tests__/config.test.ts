import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fillPlaceholders,
  findWorkflowFiles,
  hashText,
  parseWorkflow,
  PROJECT_WORKFLOWS_DIR,
  readWorkflowFile,
  slugify,
  slugOf,
  targetOf,
  WorkflowFileError
} from '../config';
import { agentsOf } from '../../../shared/workflows';
import { STARTERS } from '../starters';
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

    expect(errorOf(text)).toContain('exactly one required input');
  });

  it('needs the PR input of a PR worktree to be required', () => {
    const input = '[[inputs]]\nname = "pr"\nlabel = "PR"\ntype = "pr"\nrequired = false\n\n';
    const text = `workspace = "pr-worktree"\n${VALID}`.replace('[[agents]]', `${input}[[agents]]`);

    expect(errorOf(text)).toContain('exactly one required input');
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

const STAGE_FILE = `name = "Build"
workspace = "new-branch"

[[stages]]
name = "Lead"

[[stages.agents]]
role = "Lead"
program = "claude"
access = "write"
talks = true
plan = true
prompt = "Plan and build."

[[stages]]
name = "Review"

[[stages.agents]]
role = "Bugs"
program = "pi"
prompt = "Look for bugs."

[[stages.agents]]
role = "Tests"
program = "pi"
prompt = "Look at tests."

[[stages]]
name = "Fix"
only_with_findings = true

[[stages.agents]]
role = "Lead"
resume = "Lead"
prompt = "Fix them."

[finish]
action = "open-pr"
`;

describe('stage files', () => {
  it('reads stages in order, with the access default', () => {
    const def = parseWorkflow(STAGE_FILE);

    expect(def.agents).toEqual([]);
    expect(def.stages?.map((stage) => stage.name)).toEqual(['Lead', 'Review', 'Fix']);
    expect(def.stages?.[1].agents[0].access).toBe('read');
  });

  it('gives a returning agent the program and access of the named agent', () => {
    const [fixer] = parseWorkflow(STAGE_FILE).stages?.[2].agents ?? [];

    expect(fixer.program).toBe('claude');
    expect(fixer.access).toBe('write');
  });

  it('refuses agents and stages in one file', () => {
    const agent = '[[agents]]\nrole = "A"\nprogram = "pi"\nprompt = "x"\n\n';
    const both = STAGE_FILE.replace('[[stages]]', `${agent}[[stages]]`);

    expect(errorOf(both)).toContain('stages or agents, not both');
  });

  it('refuses a file with no agents and no stages', () => {
    expect(errorOf('name = "Empty"\n')).toBe('A workflow needs stages or agents.');
  });

  it('refuses plan with read access', () => {
    const text = STAGE_FILE.replace('access = "write"\n', '');

    expect(errorOf(text)).toContain('Lead has plan = true');
  });

  it('refuses a resume with no earlier agent', () => {
    expect(errorOf(STAGE_FILE.replace('resume = "Lead"', 'resume = "Nobody"'))).toContain(
      'no earlier stage'
    );
  });

  it('refuses a resume that is not earlier', () => {
    const text = STAGE_FILE.replace('role = "Bugs"', 'role = "Bugs"\nresume = "Tests"');

    expect(errorOf(text)).toContain('no earlier stage');
  });

  it('refuses a resume with another program', () => {
    const text = STAGE_FILE.replace('resume = "Lead"', 'resume = "Lead"\nprogram = "pi"');

    expect(errorOf(text)).toContain('must use the program of Lead');
  });

  it('refuses a repeated role with no resume', () => {
    const text = STAGE_FILE.replace('role = "Bugs"', 'role = "Tests"');

    expect(errorOf(text)).toContain('same role');
  });

  it('refuses a skippable first stage', () => {
    const text = STAGE_FILE.replace(
      'name = "Lead"\n',
      'name = "Lead"\nonly_with_findings = true\n'
    );

    expect(errorOf(text)).toContain('first stage');
  });

  it('refuses only_with_findings with no board', () => {
    const text = STAGE_FILE.replace('workspace =', 'board = false\nworkspace =');

    expect(errorOf(text)).toContain('needs board = true');
  });

  it('refuses a finish after a stage of many agents', () => {
    const noFix = `${STAGE_FILE.slice(0, STAGE_FILE.indexOf('[[stages]]\nname = "Fix"'))}[finish]\naction = "open-pr"\n`;

    expect(errorOf(noFix)).toContain('last stage must have one agent');
  });

  it('refuses open-pr with no new branch', () => {
    expect(errorOf(STAGE_FILE.replace('workspace = "new-branch"\n', ''))).toContain(
      'needs workspace = "new-branch"'
    );
  });

  it('finds a placeholder with no input in a stage prompt', () => {
    expect(errorOf(STAGE_FILE.replace('Fix them.', 'Fix {{nope}}.'))).toContain('{{nope}}');
  });
});

/** Approval is tied to these hashes, so a new one would ask each person to approve again. */
const OLD_STARTER_HASHES = {
  'pr-review': '4d792e886a0de72124f6dd300cc9d4300603844d03bb1bac89af413d7bff61d0',
  research: '45bb8946c6f4b81594876d964b0639c046589c8967d59d3e547ab670296c3371',
  'agent-task': '20df39b42cd4b7314f2b45e64b9d6ac6ad03b27a532ba39e9accdd633af64399'
};

describe('old starters', () => {
  for (const [id, hash] of Object.entries(OLD_STARTER_HASHES)) {
    const starter = STARTERS.find((each) => each.id === id);

    it(`keeps ${id} as an agents file`, () => {
      expect(parseWorkflow(starter?.text ?? '').stages).toBeUndefined();
    });

    it(`keeps the approval of ${id}`, () => {
      expect(hashText(starter?.text ?? '')).toBe(hash);
    });
  }
});

const ISSUE_FILE = `name = "Issue review"

[[inputs]]
name = "issue"
label = "Issue"
type = "issue"

[[agents]]
role = "Reader"
program = "pi"
prompt = "Read it."

[finish]
action = "post-issue"
`;

describe('issue inputs', () => {
  it('takes a required issue input with post-issue', () => {
    const def = parseWorkflow(ISSUE_FILE);

    expect(def.inputs[0].type).toBe('issue');
    expect(def.finish?.action).toBe('post-issue');
  });

  it('refuses post-issue with no issue input', () => {
    const text = ISSUE_FILE.replace('type = "issue"', 'type = "text"');

    expect(() => parseWorkflow(text)).toThrow(
      'action = "post-issue" needs one required input with type = "issue".'
    );
  });

  it('refuses post-issue with an optional issue input', () => {
    const text = ISSUE_FILE.replace('type = "issue"', 'type = "issue"\nrequired = false');

    expect(() => parseWorkflow(text)).toThrow('post-issue');
  });

  it('refuses two issue inputs', () => {
    const second = '[[inputs]]\nname = "other"\nlabel = "Other"\ntype = "issue"\n\n[[agents]]';
    const text = ISSUE_FILE.replace('[[agents]]', second);

    expect(() => parseWorkflow(text)).toThrow('only one input with type = "issue"');
  });

  it('uses the issue number for the slug and the target', () => {
    const def = parseWorkflow(ISSUE_FILE);

    expect(slugOf(def, { issue: '748' })).toBe('issue-748');
    expect(targetOf(def, { issue: '748' })).toBe('issue:748');
  });

  it('runs every agent of the issue starter with no way to change code', () => {
    const starter = STARTERS.find((candidate) => candidate.id === 'issue-review');
    const def = parseWorkflow(starter?.text ?? '');

    expect(agentsOf(def).map((agent) => agent.access)).toEqual(['read', 'read', 'read', 'read']);
    expect(def.finish?.action).toBe('post-issue');
    expect(starter?.text).not.toContain('gh ');
  });
});

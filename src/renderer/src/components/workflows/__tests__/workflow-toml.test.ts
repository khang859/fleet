import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from '../../../../../shared/workflows';
import { formToToml, parseToForm } from '../workflow-toml';

const AGENT = { role: 'Reader', program: 'pi', prompt: 'Read it.' } as const;

const SMALL: WorkflowDef = {
  name: 'Small',
  shared: '',
  board: true,
  workspace: 'current',
  inputs: [],
  agents: [AGENT]
};

const FULL: WorkflowDef = {
  name: 'Full review',
  shared: 'Be careful.',
  board: false,
  workspace: 'pr-worktree',
  inputs: [
    { name: 'pr', label: 'Pull request', type: 'pr', required: true },
    { name: 'note', label: 'Note', type: 'text', required: false }
  ],
  agents: [AGENT, { role: 'Tester', program: 'claude', prompt: 'Run the tests.' }],
  judge: { role: 'Judge', program: 'claude', prompt: 'Merge the findings.' },
  finish: { action: 'post-pr' }
};

/** The same text is in main's config.test.ts, which checks that main accepts it. */
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

function roundTrip(def: WorkflowDef): WorkflowDef {
  return parseToForm(formToToml(def));
}

describe('parseToForm', () => {
  it('fills the defaults of a short file', () => {
    const form = parseToForm('name = "Short"\n\n[[agents]]\nrole = "A"\nprompt = "Go."\n');

    expect(form).toEqual({
      name: 'Short',
      shared: '',
      board: true,
      workspace: 'current',
      inputs: [],
      agents: [{ role: 'A', program: 'pi', prompt: 'Go.' }],
      judge: undefined,
      finish: undefined
    });
  });

  it('reads an empty file as an empty form', () => {
    const form = parseToForm('');

    expect(form.name).toBe('');
    expect(form.agents).toEqual([]);
  });

  it('reads the defaults of an input', () => {
    const form = parseToForm('[[inputs]]\nname = "task"\nlabel = "Task"\n');

    expect(form.inputs).toEqual([{ name: 'task', label: 'Task', type: 'text', required: true }]);
  });

  it('reads a judge', () => {
    const form = parseToForm('[judge]\nrole = "J"\nprogram = "claude"\nprompt = "Pick."\n');

    expect(form.judge).toEqual({ role: 'J', program: 'claude', prompt: 'Pick.' });
  });

  it('reads a finish path', () => {
    const form = parseToForm('[finish]\naction = "save-report"\npath = "reports/{{pr}}.md"\n');

    expect(form.finish).toEqual({ action: 'save-report', path: 'reports/{{pr}}.md' });
  });

  it('reads a finish with no action as save-report', () => {
    expect(parseToForm('[finish]\n').finish).toEqual({ action: 'save-report' });
  });

  it('drops values of the wrong type', () => {
    const text = 'name = 3\nboard = "no"\n[finish]\naction = "post-pr"\npath = 7\n';
    const form = parseToForm(text);

    expect(form.name).toBe('');
    expect(form.board).toBe(true);
    expect(form.finish).toEqual({ action: 'post-pr' });
  });

  it('drops a judge or finish that is not a table', () => {
    const form = parseToForm('judge = "Bob"\nfinish = 1\n');

    expect(form.judge).toBeUndefined();
    expect(form.finish).toBeUndefined();
  });

  it('throws on bad TOML', () => {
    expect(() => parseToForm('name = ')).toThrow();
  });
});

describe('formToToml', () => {
  it('leaves out a judge and a finish that are not set', () => {
    const text = formToToml(SMALL);

    expect(text).not.toContain('judge');
    expect(text).not.toContain('finish');
  });

  it('leaves out a finish path that is not set', () => {
    expect(formToToml(FULL)).not.toContain('path');
  });

  it('writes a form with undefined keys without a throw', () => {
    const form: WorkflowDef = { ...SMALL, judge: undefined, finish: undefined };

    expect(() => formToToml(form)).not.toThrow();
  });
});

describe('round trip', () => {
  it('keeps a small form', () => {
    expect(roundTrip(SMALL)).toEqual(SMALL);
  });

  it('keeps a full form with judge and inputs', () => {
    expect(roundTrip(FULL)).toEqual(FULL);
  });

  it('keeps a finish path', () => {
    const form: WorkflowDef = {
      ...SMALL,
      finish: { action: 'save-report', path: 'reports/{{pr}}.md' }
    };

    expect(roundTrip(form).finish).toEqual(form.finish);
  });

  it('keeps the order of inputs and agents', () => {
    const form = roundTrip(FULL);

    expect(form.inputs.map((input) => input.name)).toEqual(['pr', 'note']);
    expect(form.agents.map((agent) => agent.role)).toEqual(['Reader', 'Tester']);
  });

  it('keeps text that TOML must escape', () => {
    const prompt = 'Line "one"\n\tC:\\path\n\nLast line: {{task}} - é 漢字\n';
    const form: WorkflowDef = { ...SMALL, shared: prompt, agents: [{ ...AGENT, prompt }] };

    expect(roundTrip(form)).toEqual(form);
  });

  it('gives the same text after a second trip', () => {
    const once = formToToml(FULL);

    expect(formToToml(parseToForm(once))).toBe(once);
  });

  it('writes the text that main reads in config.test.ts', () => {
    const form: WorkflowDef = {
      ...SMALL,
      inputs: [FULL.inputs[0]],
      judge: FULL.judge,
      finish: { action: 'save-report', path: 'out.md' }
    };

    expect(formToToml(form)).toBe(EDITOR_FILE);
  });
});

const STAGE_FILE = `name = "Build"
shared = ""
board = true
workspace = "new-branch"
inputs = []

[[stages]]
name = "Lead"

[[stages.agents]]
role = "Lead"
program = "claude"
access = "write"
talks = true
plan = true
prompt = "Plan."

[[stages]]
name = "Fix"
only_with_findings = true

[[stages.agents]]
role = "Lead"
access = "write"
resume = "Lead"
prompt = "Fix."

[finish]
action = "open-pr"
`;

describe('stage files', () => {
  it('reads what main reads', () => {
    const def = parseToForm(STAGE_FILE);

    expect(def.workspace).toBe('new-branch');
    expect(def.finish?.action).toBe('open-pr');
    expect(def.stages?.[1].only_with_findings).toBe(true);
    expect(def.stages?.[1].agents[0]).toMatchObject({ program: 'claude', resume: 'Lead' });
  });

  it('writes the same file back', () => {
    expect(formToToml(parseToForm(STAGE_FILE)).trim()).toBe(STAGE_FILE.trim());
  });

  it('keeps the old shape for an old file', () => {
    expect(formToToml(FULL)).toContain('[[agents]]');
    expect(formToToml(FULL)).not.toContain('stages');
  });
});

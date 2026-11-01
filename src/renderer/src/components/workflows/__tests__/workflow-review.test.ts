import { describe, expect, it } from 'vitest';
import type { WorkflowDef, WorkflowEntry } from '../../../../../shared/workflows';
import { buildReview, fileLines, reviewOf, reviewSummary } from '../workflow-review';
import { formToToml } from '../workflow-toml';

const READER = { role: 'Reader', program: 'pi', prompt: 'Read it.\nThen stop.\n' } as const;
const JUDGE = { role: 'Judge', program: 'claude', prompt: 'Merge it.' } as const;

const DEF: WorkflowDef = {
  name: 'Small',
  shared: 'Be careful.\n',
  board: true,
  workspace: 'current',
  inputs: [{ name: 'topic', label: 'Topic', type: 'text', required: true }],
  agents: [READER],
  judge: JUDGE,
  finish: { action: 'save-report', path: 'docs/out.md' }
};

function entryOf(def: WorkflowDef | null, approvedText: string | null): WorkflowEntry {
  return {
    id: 'small',
    path: '/tmp/small.toml',
    scope: 'project',
    hash: 'h',
    def,
    error: null,
    approval: approvedText === null ? 'needs-approval' : 'changed',
    replacesPersonal: false,
    approvedText
  };
}

describe('buildReview', () => {
  it('shows a new file with no change marks', () => {
    const review = buildReview(DEF, null);

    expect(review.agents.map((agent) => agent.status)).toEqual(['same', 'same']);
    expect(review.agents.flatMap((agent) => agent.lines).every((l) => l.sign === ' ')).toBe(true);
    expect(review.shared).toEqual([{ sign: ' ', text: 'Be careful.' }]);
    expect(review.settings.some((setting) => setting.was !== undefined)).toBe(false);
  });

  it('marks a changed prompt in file order, with the same lines left plain', () => {
    const changed = { ...READER, prompt: 'Read it.\nThen report.\nThen stop.\n' };
    const review = buildReview({ ...DEF, agents: [changed] }, DEF);

    expect(review.agents[0].status).toBe('changed');
    expect(review.agents[0].lines).toEqual([
      { sign: ' ', text: 'Read it.' },
      { sign: '+', text: 'Then report.' },
      { sign: ' ', text: 'Then stop.' }
    ]);
    expect(review.agents[1].status).toBe('same');
  });

  it('finds new and removed agents by role', () => {
    const added = { role: 'Tester', program: 'pi', prompt: 'Test it.' } as const;
    const review = buildReview({ ...DEF, agents: [added] }, DEF);

    expect(review.agents.map((agent) => [agent.role, agent.status])).toEqual([
      ['Tester', 'new'],
      ['Judge', 'same'],
      ['Reader', 'removed']
    ]);
    expect(review.agents[0].lines).toEqual([{ sign: '+', text: 'Test it.' }]);
    expect(review.agents[2].lines[0]).toEqual({ sign: '-', text: 'Read it.' });
  });

  it('marks a change of program, and a move to last place', () => {
    const review = buildReview(
      { ...DEF, agents: [JUDGE], judge: { ...READER, program: 'claude' } },
      DEF
    );

    const reader = review.agents.find((agent) => agent.role === 'Reader');
    const judge = review.agents.find((agent) => agent.role === 'Judge');
    expect(reader).toMatchObject({ status: 'changed', wasProgram: 'pi', last: true });
    expect(judge).toMatchObject({ status: 'changed', wasProgram: undefined, last: false });
  });

  it('keeps the old value of a changed setting, and shows the name only if it changed', () => {
    const def: WorkflowDef = { ...DEF, name: 'Big', finish: undefined };
    const review = buildReview(def, DEF);

    expect(review.settings.find((row) => row.label === 'Name')).toEqual({
      label: 'Name',
      value: 'Big',
      was: 'Small'
    });
    expect(review.settings.find((row) => row.label === 'Finish')).toEqual({
      label: 'Finish',
      value: 'Show the report in Fleet',
      was: 'Save the report to docs/out.md'
    });
    expect(buildReview(DEF, null).settings.some((row) => row.label === 'Name')).toBe(false);
  });

  it('counts an input with a new name as a change', () => {
    const inputs = [{ ...DEF.inputs[0], name: 'subject' }];
    const review = buildReview({ ...DEF, inputs }, DEF);

    expect(review.settings.find((row) => row.label === 'Inputs')?.was).toContain('{{topic}}');
  });
});

describe('reviewSummary', () => {
  it('names what changed', () => {
    const added = { role: 'Tester', program: 'pi', prompt: 'Test it.' } as const;
    const prompt = 'Read it.\n';
    const def: WorkflowDef = {
      ...DEF,
      shared: 'Be very careful.\n',
      board: false,
      agents: [{ ...READER, prompt }, added]
    };

    expect(reviewSummary(buildReview(def, DEF))).toBe(
      '1 agent changed. 1 new agent. Shared instructions changed. Settings changed.'
    );
  });

  it('says so when nothing that runs changed', () => {
    expect(reviewSummary(buildReview(DEF, DEF))).toBe('Only comments, spacing or order changed.');
  });
});

describe('reviewOf', () => {
  it('compares with the approved text', () => {
    const def = { ...DEF, board: false };
    const review = reviewOf(entryOf(def, formToToml(DEF)));

    expect(review?.settings.find((row) => row.label === 'Board')?.was).toContain('On');
  });

  it('has no sections for a file that does not parse', () => {
    expect(reviewOf(entryOf(null, null))).toBeNull();
  });

  it('has no sections when the approved text does not parse', () => {
    expect(reviewOf(entryOf(DEF, 'name = '))).toBeNull();
  });
});

describe('fileLines', () => {
  it('shows a new file plain, with no empty last line', () => {
    expect(fileLines(null, 'a\n\nb\n')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: ' ', text: '' },
      { sign: ' ', text: 'b' }
    ]);
  });

  it('ignores only a missing last newline', () => {
    expect(fileLines('a\nb\n', 'a\nb')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: ' ', text: 'b' }
    ]);
  });

  it('keeps a removed line where it was', () => {
    expect(fileLines('a\nb\nc\n', 'a\nc\n')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: ' ', text: 'c' }
    ]);
  });
});

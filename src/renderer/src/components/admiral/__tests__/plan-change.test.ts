import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyPlanVersion } from '../../../../../shared/agency-jobs';
import { PlanSchema, type PlanDiffEntry } from '../../../../../shared/agency-plan';
import { PlanReader } from '../PlanReader';
import { budgetBefore, removedSteps, stepCountBefore, stepMarks } from '../plan-diff';
import { detail, job, PLAN, version } from './queue-fixtures';

/** A plan v2 against the v1 the client asked to change: what the reader marks. */

const step = (id: string, title: string): { id: string; role: string; title: string } => ({
  id,
  role: 'builder',
  title
});

const V1 = PlanSchema.parse({
  ...PLAN,
  steps: [step('a', 'Read the code'), step('b', 'Fix lint'), step('c', 'Old docs pass')],
  budget: { usd: 10, weekPct: 8 }
});

const V2 = PlanSchema.parse({
  ...PLAN,
  steps: [step('b', 'Fix lint and types'), step('a', 'Read the code'), step('d', 'Run the tests')],
  budget: { usd: 6, weekPct: 5 }
});

const DIFF: PlanDiffEntry[] = [
  { kind: 'moved', step: 'b' },
  { kind: 'moved', step: 'a' },
  { kind: 'changed', step: 'b', fields: ['title', 'cap'] },
  { kind: 'added', step: 'd' },
  { kind: 'removed', step: 'c' },
  { kind: 'budget', from: 10, to: 6 },
  { kind: 'week_share', from: 8, to: 5 }
];

function versions(note: string | null): { v1: AgencyPlanVersion; v2: AgencyPlanVersion } {
  const v1 = version({ id: 6, status: 'replaced', plan: V1 });
  const v2 = version({
    version: 2,
    parentVersion: 1,
    plan: V2,
    diff: DIFF,
    previous: { version: 1, status: 'replaced', note, diff: DIFF }
  });
  return { v1, v2 };
}

const read = (note: string | null): string => {
  const { v1, v2 } = versions(note);
  const planned = job({ pendingPlan: { id: 7, version: 2 } });
  return renderToStaticMarkup(
    createElement(PlanReader, {
      version: v2,
      detail: detail(planned, { versions: [v1, v2] }),
      head: null
    })
  );
};

describe('what changed in a plan', () => {
  it('marks each step: moved up or down, changed by field, and new', () => {
    const marks = stepMarks(DIFF, V2, V1);
    expect(marks.get('b')).toEqual({ added: false, moved: 'up', changed: ['title', 'cap'] });
    expect(marks.get('a')).toEqual({ added: false, moved: 'down', changed: [] });
    expect(marks.get('d')).toEqual({ added: true, moved: null, changed: [] });
  });

  it('names a removed step by its title, or by its id without the version before', () => {
    expect(removedSteps(DIFF, V1)).toEqual([{ id: 'c', title: 'Old docs pass' }]);
    expect(removedSteps(DIFF, undefined)).toEqual([{ id: 'c', title: 'c' }]);
  });

  it('counts the steps and finds the budget the version before had', () => {
    expect(stepCountBefore(DIFF, V2)).toBe(3);
    expect(stepCountBefore([{ kind: 'added', step: 'd' }], V2)).toBe(2);
    expect(budgetBefore(DIFF)).toEqual({ usd: 10, weekPct: 8 });
    expect(budgetBefore([])).toEqual({});
  });

  it('shows the note, the old budget struck through, and every mark in the reader', () => {
    const html = read('Do lint first, and drop the docs pass.');
    expect(html).toContain('Changes since v1 (replaced)');
    expect(html).toContain('YOU SAID');
    expect(html).toContain('Do lint first, and drop the docs pass.');
    expect(html).toMatch(/<s[^>]*>\$10<\/s>\$6/);
    expect(html).toMatch(/<s[^>]*>8%<\/s>5% Claude week/);
    expect(html).toContain('MOVED UP');
    expect(html).toContain('MOVED DOWN');
    expect(html).toContain('CHANGED: TITLE, CAP');
    expect(html).toContain('NEW');
    expect(html).toMatch(/REMOVED<\/span><span[^>]*line-through[^>]*>Old docs pass/);
    expect(html).toContain('>See v1<');
    expect(html).toMatch(/role="switch" id="plan-show-changes" aria-checked="true"/);
  });

  it('keeps the changes line for a v2 with no note, and says nothing for the note', () => {
    const html = read(null);
    expect(html).toContain('Changes since v1 (replaced)');
    expect(html).not.toContain('YOU SAID');
    expect(html).toContain('MOVED UP');
  });

  it('shows no changes line on a v1, and Edit the plan in the footer', () => {
    const html = renderToStaticMarkup(
      createElement(PlanReader, {
        version: version(),
        detail: detail(job(), { versions: [version()] }),
        head: null
      })
    );
    expect(html).not.toContain('Changes since');
    expect(html).not.toContain('<s ');
    expect(html).toContain('>Edit the plan<');
  });
});

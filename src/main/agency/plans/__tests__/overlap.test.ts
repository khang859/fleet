import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../../../../shared/agency-plan';
import { normalizePath, planOverlap, splitMember } from '../overlap';

const plan = (paths: string[]): ReturnType<typeof PlanSchema.parse> =>
  PlanSchema.parse({
    playbook: 'feature',
    summary: 'S',
    steps: [{ id: 'builder-1', role: 'builder', title: 'Build', paths }],
    budget: { usd: 5 }
  });

describe('normalizePath', () => {
  it.each([
    ['src/app/', 'src/app'],
    ['src/app/*', 'src/app'],
    ['src/app/**', 'src/app'],
    ['./src/app', 'src/app'],
    ['  src/Sidebar.tsx ', 'src/Sidebar.tsx']
  ])('%s is %s', (raw, clean) => {
    expect(normalizePath(raw)).toBe(clean);
  });
});

describe('splitMember', () => {
  it('reads the member off the front, and puts any other path in the first member', () => {
    expect(splitMember('web/src/app', ['api', 'web'])).toEqual({ member: 'web', path: 'src/app' });
    expect(splitMember('web', ['api', 'web'])).toEqual({ member: 'web', path: '' });
    expect(splitMember('src/app', ['fleet'])).toEqual({ member: 'fleet', path: 'src/app' });
  });
});

describe('planOverlap', () => {
  const other = (
    paths: string[],
    jobId = 3
  ): { jobId: number; steps: Array<{ step: string; paths: string[] }> } => ({
    jobId,
    steps: [{ step: 'builder-1', paths }]
  });

  it.each<[string, string[], string[], string | null]>([
    ['the same file', ['src/Sidebar.tsx'], ['src/Sidebar.tsx'], 'src/Sidebar.tsx'],
    [
      'a file in a folder the other touches',
      ['src/components/'],
      ['src/components/Sidebar.tsx'],
      'src/components/Sidebar.tsx'
    ],
    ['a whole member', ['fleet'], ['src/app'], 'src/app'],
    ['sibling folders', ['src/app'], ['src/application'], null],
    ['unrelated files', ['README.md'], ['src/main.ts'], null]
  ])('%s', (_, mine, theirs, path) => {
    const rows = planOverlap(plan(mine), ['fleet'], [other(theirs)]);
    expect(rows).toEqual(
      path === null ? [] : [{ jobId: 3, member: 'fleet', path, step: 'builder-1' }]
    );
  });

  it('compares paths per member', () => {
    const rows = planOverlap(plan(['api/src']), ['api', 'web'], [other(['web/src'])]);
    expect(rows).toEqual([]);
  });

  it('lists each other job once per path', () => {
    const rows = planOverlap(
      plan(['src/a.ts', 'src/a.ts/']),
      ['fleet'],
      [other(['src/a.ts'], 3), other(['src'], 4)]
    );
    expect(rows).toEqual([
      { jobId: 3, member: 'fleet', path: 'src/a.ts', step: 'builder-1' },
      { jobId: 4, member: 'fleet', path: 'src/a.ts', step: 'builder-1' }
    ]);
  });
});

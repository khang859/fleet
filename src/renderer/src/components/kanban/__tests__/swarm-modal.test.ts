import { describe, it, expect } from 'vitest';
import { rowsToWorkerSpecs } from '../SwarmModal';

describe('rowsToWorkerSpecs', () => {
  it('maps non-empty rows to specs and splits skills on commas', () => {
    const specs = rowsToWorkerSpecs([
      { profile: 'researcher', title: 'Research', skills: 'web, papers' },
      { profile: '', title: 'ignored', skills: '' },
      { profile: 'architect', title: 'Design', skills: '' }
    ]);
    expect(specs).toEqual([
      { profile: 'researcher', title: 'Research', skills: ['web', 'papers'] },
      { profile: 'architect', title: 'Design', skills: [] }
    ]);
  });

  it('drops rows missing a profile or a title', () => {
    expect(rowsToWorkerSpecs([{ profile: 'x', title: '', skills: '' }])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  FULL_FEATURE,
  QUICK_FIX,
  getTemplate,
  MAX_FANOUT,
  QA_ATTEMPT_CAP
} from '../kanban/pipeline-templates';

describe('pipeline-templates', () => {
  it('FULL_FEATURE lays down explore → spec → gate → qa', () => {
    expect(FULL_FEATURE.id).toBe('full_feature');
    expect(FULL_FEATURE.stages).toEqual(['explore', 'spec', 'gate', 'qa']);
  });

  it('QUICK_FIX is inert (no stages)', () => {
    expect(QUICK_FIX.id).toBe('quick_fix');
    expect(QUICK_FIX.stages).toEqual([]);
  });

  it('getTemplate resolves full_feature and falls back to quick_fix', () => {
    expect(getTemplate('full_feature')).toBe(FULL_FEATURE);
    expect(getTemplate('quick_fix')).toBe(QUICK_FIX);
    expect(getTemplate(null)).toBe(QUICK_FIX);
    expect(getTemplate(undefined)).toBe(QUICK_FIX);
  });

  it('caps are the spec values', () => {
    expect(MAX_FANOUT).toBe(12);
    expect(QA_ATTEMPT_CAP).toBe(2);
  });
});

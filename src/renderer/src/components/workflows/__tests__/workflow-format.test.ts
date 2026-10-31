import { describe, expect, it } from 'vitest';
import type { WorkflowEntry } from '../../../../../shared/workflows';
import { hasPrInput } from '../workflow-format';

function entryWith(type: 'pr' | 'text'): WorkflowEntry {
  const inputs = [{ name: 'one', label: 'One', type, required: true }];
  return { def: { inputs } } as unknown as WorkflowEntry;
}

describe('hasPrInput', () => {
  it('sees a PR input', () => {
    expect(hasPrInput(entryWith('pr'))).toBe(true);
  });

  it('is false for other inputs and for a missing workflow', () => {
    expect(hasPrInput(entryWith('text'))).toBe(false);
    expect(hasPrInput(undefined)).toBe(false);
  });
});

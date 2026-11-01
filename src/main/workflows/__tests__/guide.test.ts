import { describe, expect, it } from 'vitest';
import { parseWorkflow, WorkflowFile } from '../config';
import { workflowGuide } from '../guide';
import { STARTERS } from '../starters';

describe('workflowGuide', () => {
  it('names every key of a workflow file', () => {
    for (const key of Object.keys(WorkflowFile.shape)) {
      expect(workflowGuide()).toContain(key);
    }
  });

  it('shows examples that a person can use as they are', () => {
    for (const { text } of STARTERS) {
      expect(workflowGuide()).toContain(text);
      expect(() => parseWorkflow(text)).not.toThrow();
    }
  });
});

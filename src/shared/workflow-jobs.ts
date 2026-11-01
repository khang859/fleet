import type { WorkflowAccess, WorkflowProgram } from './workflows';

/** A filled card for Add agent. Its text is copied into the file, so approval covers it. */
export type WorkflowJob = {
  id: string;
  label: string;
  description: string;
  role: string;
  access: WorkflowAccess;
  talks?: boolean;
  plan?: boolean;
  program?: WorkflowProgram;
  prompt: string;
};

export const WORKFLOW_JOBS: WorkflowJob[] = [
  {
    id: 'lead',
    label: 'Talk, plan and build',
    description: 'Talks with you, gets its plan approved, then changes code.',
    role: 'Lead',
    access: 'write',
    talks: true,
    plan: true,
    prompt:
      'Read the code first.\nAsk the person questions until you agree on what to build.\nThen write the plan.\nAfter a person approves it, build it, run the tests and commit your work.'
  },
  {
    id: 'explore',
    label: 'Explore the code',
    description: 'Reads the code and reports how it works.',
    role: 'Explorer',
    access: 'read',
    prompt: 'Read the code that this task touches. Report how it works and what can go wrong.'
  },
  {
    id: 'bugs',
    label: 'Review for bugs',
    description: 'Looks for logic bugs and wrong edge cases.',
    role: 'Correctness',
    access: 'read',
    prompt: 'Compare the change with the plan. Look for logic bugs and wrong edge cases.'
  },
  {
    id: 'patterns',
    label: 'Review for patterns',
    description: 'Looks for code that does not fit this repo.',
    role: 'Best practices',
    access: 'read',
    prompt: 'Look for code in the change that does not follow the patterns of this repo.'
  },
  {
    id: 'tests',
    label: 'Review the tests',
    description: 'Looks for changed behavior with no test.',
    role: 'Tests',
    access: 'read',
    prompt: 'Look for changed behavior that has no test, and for weak tests.'
  },
  {
    id: 'fix',
    label: 'Fix the findings',
    description: 'Fixes the real problems on the board.',
    role: 'Fixer',
    access: 'write',
    prompt: 'Read the board. Fix the real problems, run the tests and commit your work.'
  },
  {
    id: 'custom',
    label: 'Your own job',
    description: 'Write the instructions yourself.',
    role: '',
    access: 'read',
    prompt: ''
  }
];

/**
 * The settings the Form view shows, and the labels it shows them under.
 *
 * Shared rather than private to the form because the effective-value strip has
 * to name the same settings in the same words. Two lists would drift, and a
 * strip that called a control something else would teach the wrong thing.
 */

export type ScalarField = {
  path: string[];
  label: string;
  /**
   * One short line, ours rather than the schema's.
   *
   * The slot has to exist on every row for the precedence notice to have
   * somewhere to go, and the schema's own descriptions run to several lines
   * and link out to docs - too long to sit under a label.
   */
  note: string;
  control: 'text' | 'enum' | 'boolean' | 'number';
};

export const SCALAR_FIELDS: ScalarField[] = [
  { path: ['model'], label: 'Model', note: 'The model new sessions start with.', control: 'text' },
  {
    path: ['outputStyle'],
    label: 'Output style',
    note: 'How Claude writes back to you.',
    control: 'text'
  },
  {
    path: ['effortLevel'],
    label: 'Effort level',
    note: 'How much thinking a session spends by default.',
    control: 'enum'
  },
  {
    path: ['permissions', 'defaultMode'],
    label: 'Permission mode',
    note: 'What happens when a tool asks to run.',
    control: 'enum'
  },
  {
    path: ['alwaysThinkingEnabled'],
    label: 'Extended thinking',
    note: 'Think before every reply.',
    control: 'boolean'
  },
  {
    path: ['autoCompactEnabled'],
    label: 'Auto compact',
    note: 'Summarise the conversation when it fills up.',
    control: 'boolean'
  },
  {
    path: ['includeCoAuthoredBy'],
    label: 'Co-authored-by byline',
    note: 'Add Claude as a co-author on commits.',
    control: 'boolean'
  },
  {
    path: ['cleanupPeriodDays'],
    label: 'Keep sessions',
    note: 'Days of transcripts to keep on disk.',
    control: 'number'
  }
];

export const LIST_FIELDS: Array<{ path: string[]; label: string; note: string; empty: string }> = [
  {
    path: ['permissions', 'allow'],
    label: 'Allow',
    note: 'Run without asking.',
    empty: 'No rules run without asking.'
  },
  {
    path: ['permissions', 'ask'],
    label: 'Ask',
    note: 'Always prompt, even in auto mode.',
    empty: 'No rules force a prompt.'
  },
  {
    path: ['permissions', 'deny'],
    label: 'Deny',
    note: 'Never run, whatever else allows it.',
    empty: 'No rules are blocked outright.'
  },
  {
    path: ['permissions', 'additionalDirectories'],
    label: 'Extra directories',
    note: 'Folders outside the working directory Claude may read.',
    empty: 'Only the working directory is reachable.'
  }
];

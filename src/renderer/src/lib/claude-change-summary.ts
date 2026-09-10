import { isRecord } from '../../../shared/is-record';
import { jsonEqual } from '../../../shared/json-equal';
import { parseSettings } from './claude-json-edit';

/**
 * Naming an unsaved edit, for the save bar.
 *
 * "Unsaved changes" tells the user nothing they cannot already see. Counting the
 * edits and naming the section they are in lets them decide whether to save
 * without scrolling back up, which matters most here: the page has three scopes
 * and the user may have wandered off to the Copilot page in between.
 *
 * The count is per *setting*, not per top-level key, so editing two permission
 * rules reads as two changes rather than one. Sections are the form's own group
 * headings, so the sentence points at something on screen.
 */

/** Top-level settings key -> the form group that holds it. */
const SECTION_OF: Record<string, string> = {
  model: 'Model and behaviour',
  outputStyle: 'Model and behaviour',
  effortLevel: 'Model and behaviour',
  alwaysThinkingEnabled: 'Model and behaviour',
  autoCompactEnabled: 'Model and behaviour',
  includeCoAuthoredBy: 'Model and behaviour',
  cleanupPeriodDays: 'Model and behaviour',
  permissions: 'Permissions',
  env: 'Environment and plugins',
  enabledPlugins: 'Environment and plugins',
  enableAllProjectMcpServers: 'Environment and plugins',
  hooks: 'Hooks'
};

export type ChangeSummary = { count: number; sections: string[]; label: string };

/** How many settings changed under one top-level key. */
function countUnder(before: unknown, after: unknown): number {
  // Two objects are compared field by field, so a permissions edit is counted
  // as the rules it touched. Anything else is one setting.
  if (!isRecord(before) || !isRecord(after)) return 1;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changed = 0;
  for (const key of keys) if (!jsonEqual(before[key], after[key])) changed += 1;
  return changed === 0 ? 1 : changed;
}

/** "A", "A and B", "A, B and C". */
export function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function summarizeChanges(savedText: string, text: string): ChangeSummary {
  const before = parseSettings(savedText);
  const after = parseSettings(text);
  // Unparseable text has no structure to count. The bar still says something
  // truthful rather than claiming a number it cannot know.
  if (before === null || after === null) {
    return { count: 0, sections: [], label: 'Unsaved changes' };
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  let count = 0;
  const sections: string[] = [];
  for (const key of keys) {
    if (jsonEqual(before[key], after[key])) continue;
    count += countUnder(before[key], after[key]);
    const section = SECTION_OF[key] ?? 'Other settings';
    if (!sections.includes(section)) sections.push(section);
  }

  if (count === 0) return { count: 0, sections: [], label: 'Unsaved changes' };
  const noun = count === 1 ? 'unsaved change' : 'unsaved changes';
  // A middot rather than "and": one of the group names already contains "and",
  // and "Permissions and Model and behaviour" parses as three things.
  const where = sections.length > 0 ? ` in ${sections.join(' \u00b7 ')}` : '';
  return { count, sections, label: `${count} ${noun}${where}` };
}

/** Top-level keys that differ between two settings documents. */
export function changedKeys(aText: string, bText: string): string[] {
  const a = parseSettings(aText);
  const b = parseSettings(bText);
  if (a === null || b === null) return [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((key) => !jsonEqual(a[key], b[key])).sort();
}

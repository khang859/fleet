import type { ClientFileProposal } from './agency';
import type { ClientLineInput } from './agency-projects';

/**
 * The client file: what the Admiral remembers about how the client likes to
 * work on one project, as plain Markdown the client can read and edit.
 *
 * Every line Fleet writes says where it came from and when, as
 * `- Open PRs as drafts. (from starter questions, 2026-10-17)`, so the client
 * can tell their own answers from rules picked out of a repository file, and
 * Fleet can replace one source's lines without touching the rest. Lines the
 * client typed themselves have no tag and are never touched.
 */

/** Where starter question answers come from, so finishing them again replaces the last answers. */
export const STARTER_SOURCE = 'starter questions';

/** A line the client gave Fleet themselves: an answer, or a line added or edited in Settings. */
export const YOU_SOURCE = 'you';

/**
 * The layer key of the preferences that hold for every project. A project's
 * layer is keyed by its project id, which is hex, so the two cannot meet.
 */
export const YOU_LAYER = 'you';

/** How the What the Admiral knows page names a line's source. */
export function sourceLabel(source: string | null): string {
  if (source === null || source === YOU_SOURCE) return 'You told me';
  if (source === STARTER_SOURCE) return 'Starter questions';
  const job = /^job (j\d+)$/.exec(source);
  if (job) return `Learned on ${job[1]}`;
  if (source === 'the Bridge') return 'Learned on the Bridge';
  return `Read from ${source}`;
}

const TAGGED = /^- (.*) \(from (.+), (\d{4}-\d{2}-\d{2})\)$/;

type Entry = { text: string; source: string; date: string };

/** A line's tag, or null for anything Fleet did not write. */
export function parseClientLine(line: string): Entry | null {
  const m = TAGGED.exec(line);
  return m ? { text: m[1], source: m[2], date: m[3] } : null;
}

export function formatClientLine(entry: Entry): string {
  return `- ${entry.text} (from ${entry.source}, ${entry.date})`;
}

/** What a list line says: its tagged text, or a hand line's text. Null for anything else. */
function lineText(line: string): string | null {
  return parseClientLine(line)?.text ?? (line.startsWith('- ') ? line.slice(2) : null);
}

/** What every list line in the file says, in order: what a proposal may replace or remove. */
export function clientEntries(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map(lineText)
    .filter((t): t is string => t !== null);
}

/** Two lines say the same thing when they differ only in case, spacing or a final period. */
export function sameText(a: string, b: string): boolean {
  return normText(a) === normText(b);
}

/** A line's normal form: what `sameText` compares, and what a line's records are keyed by. */
export function normText(s: string): string {
  return oneLine(s).replace(/\.$/, '').toLowerCase();
}

/** A rule as one line: no line breaks, no leading list marker. */
export function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s+/, '')
    .trim();
}

/**
 * The client file with `add` written into it.
 *
 * Lines from `replaceSource` are dropped first, so answering the starter
 * questions again leaves one set of answers. A line that says what the file
 * already says is skipped, whichever source said it first. Everything else in
 * the file stays as it was, in its place.
 */
export function mergeClientFile(
  existing: string | null,
  input: { name: string; replaceSource?: string; add: ClientLineInput[] },
  date: string
): string {
  const lines = (existing ?? `# ${input.name}\n`).replace(/\s+$/, '').split('\n');
  const kept = lines.filter((line) => {
    const entry = parseClientLine(line);
    return entry === null || entry.source !== input.replaceSource;
  });
  const said = (): string[] => kept.map(lineText).filter((t): t is string => t !== null);
  for (const add of input.add) {
    const text = oneLine(add.text);
    if (text === '' || said().some((t) => sameText(t, text))) continue;
    kept.push(formatClientLine({ text, source: add.source, date }));
  }
  return `${kept.join('\n')}\n`;
}

/**
 * The client file with an approved proposal written in. A line it replaces is
 * swapped in place, so the file keeps its order; a removed line goes; the rest
 * are added like any other lines. A replaced or removed line the client has
 * since edited away is simply not there to change.
 */
export function applyClientProposal(
  existing: string | null,
  input: { name: string; source: string; proposal: ClientFileProposal },
  date: string
): string {
  const lines = (existing ?? `# ${input.name}\n`).replace(/\s+$/, '').split('\n');
  const at = (text: string): number =>
    lines.findIndex((line) => {
      const said = lineText(line);
      return said !== null && sameText(said, text);
    });
  for (const text of input.proposal.remove) {
    const i = at(text);
    if (i >= 0) lines.splice(i, 1);
  }
  const rest: ClientLineInput[] = [];
  for (const add of input.proposal.add) {
    const i = add.replaces === null ? -1 : at(add.replaces);
    const text = oneLine(add.text);
    if (i >= 0 && text !== '') lines[i] = formatClientLine({ text, source: input.source, date });
    else rest.push({ text: add.text, source: input.source });
  }
  return mergeClientFile(lines.join('\n'), { name: input.name, add: rest }, date);
}

/** One list line of a layer: what it says, and where it came from when Fleet wrote it. */
export type ClientEntry = { text: string; source: string | null; date: string | null };

/** Every list line of a layer, in order, with its tag. Their positions are what edits name. */
export function clientEntryList(text: string | null): ClientEntry[] {
  return (text ?? '').split('\n').flatMap((line): ClientEntry[] => {
    const tagged = parseClientLine(line);
    if (tagged) return [tagged];
    return line.startsWith('- ') ? [{ text: line.slice(2), source: null, date: null }] : [];
  });
}

/**
 * The file line of the list line at `index`, when it still says `was`. A
 * line that moved or changed since the client saw it is not touched.
 */
function entryLine(lines: string[], index: number, was: string): number {
  let seen = -1;
  for (const [i, line] of lines.entries()) {
    const said = lineText(line);
    if (said === null) continue;
    seen += 1;
    if (seen === index) return sameText(said, was) ? i : -1;
  }
  return -1;
}

/**
 * The layer with the list line at `index` rewritten as `text`: a Fleet line
 * becomes one the client told Fleet, a hand line stays a hand line. Null when
 * the line is no longer there as the client saw it.
 */
export function editClientLine(
  existing: string | null,
  input: { index: number; was: string; text: string },
  date: string
): string | null {
  const lines = (existing ?? '').replace(/\s+$/, '').split('\n');
  const i = entryLine(lines, input.index, input.was);
  const text = oneLine(input.text);
  if (i < 0 || text === '') return null;
  lines[i] =
    parseClientLine(lines[i]) === null
      ? `- ${text}`
      : formatClientLine({ text, source: YOU_SOURCE, date });
  return `${lines.join('\n')}\n`;
}

/** The layer without the list line at `index`; null when it is no longer there as the client saw it. */
export function removeClientLine(
  existing: string | null,
  input: { index: number; was: string }
): string | null {
  const lines = (existing ?? '').replace(/\s+$/, '').split('\n');
  const i = entryLine(lines, input.index, input.was);
  if (i < 0) return null;
  lines.splice(i, 1);
  return `${lines.join('\n')}\n`;
}

/** A layer's list lines numbered for the Admiral's note, as `Y1`, `Y2` or `P1`, `P2`. */
export function numberedEntries(
  text: string | null,
  prefix: 'Y' | 'P'
): Array<{ id: string; entry: ClientEntry }> {
  return clientEntryList(text).map((entry, i) => ({ id: `${prefix}${i + 1}`, entry }));
}

/**
 * A layer as the Admiral's note shows it: each list line numbered by its id,
 * other lines as written, the file's own heading left out.
 */
export function numberedText(text: string, prefix: 'Y' | 'P'): string {
  let n = 0;
  return text
    .split('\n')
    .filter((line) => !line.startsWith('# '))
    .map((line) => (lineText(line) === null ? line : `${prefix}${(n += 1)}. ${line.slice(2)}`))
    .join('\n')
    .trim();
}

/**
 * A preference line that clashes with a rule in an instruction file. It stays
 * `open` until the client picks the line (`line`) or the rule (`rule`).
 */
export type PreferenceConflict = {
  id: number;
  layer: string;
  /** The line in `sameText`'s normal form. */
  normText: string;
  /** Where the rule is, like `CLAUDE.md`. */
  ruleSource: string;
  ruleText: string;
  status: 'open' | 'line' | 'rule';
};

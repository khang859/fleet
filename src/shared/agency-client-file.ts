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
  const norm = (s: string): string =>
    s.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** A rule as one line: no line breaks, no leading list marker. */
function oneLine(text: string): string {
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

/**
 * Pulling file paths out of a line of terminal text.
 *
 * Agents and build tools print paths constantly - `Read src/main/index.ts`,
 * `src/app.ts:15:9`, `✓ src/shared/__tests__/x.test.ts` - and this is the part
 * that finds them. It is deliberately pure: no xterm, no DOM, no `fs`. What it
 * returns is a *candidate*, not a file. Whether the thing exists is settled
 * later by a `stat`, which is what keeps this side free to be a little generous.
 *
 * Two rules shape everything below.
 *
 * A candidate must carry a separator or an unambiguous prefix (`~`, `./`, `../`,
 * a drive letter) - or else be the name of something the caller says is really
 * there. Grammar alone cannot tell `index.ts` from `Node.js`, `v1.2.3` or
 * `e.g.`, and guessing would cost a `stat` per word to find that out. So the
 * caller may pass the entry names of the directory the text was printed in, and
 * a bare token is a path exactly when it is one of them: `ls` output becomes
 * clickable, and prose costs nothing, because membership is a set lookup.
 *
 * `\\server\share` is never matched. Not a simplification - a safety property.
 * A path like that handed to `shell.showItemInFolder` on Windows makes the OS
 * reach out to an SMB host and authenticate, so PTY text that could name one is
 * how a hostile build log gets a password hash out of the machine. Excluding the
 * shape here means there is no blocklist anywhere else to forget to apply.
 */

import { isUncPath, isWindowsPath } from './path-platform';

export type PathCandidate = {
  /** The path alone: enclosing punctuation gone, `:line:col` suffix removed. */
  text: string;
  /** Offset of `text` within the line it was found in. */
  index: number;
  /** 1-based, as printed. */
  line?: number;
  col?: number;
  /**
   * Matched by name against a directory listing rather than by grammar, which
   * means its existence is already settled and the caller owes it no `stat`.
   */
  bare?: true;
};

/**
 * Characters that may appear inside a path segment. Space is absent, which is
 * what makes whitespace the token boundary and `/path/with spaces/x` only
 * partly matchable. Quoting conventions vary too much between tools to guess at,
 * and the truncated candidate simply fails its `stat` and is never decorated.
 */
const SEGMENT_CHARS = /^[\w.@+%-]+$/;

/** Openers stripped from the left, in the order a shell or prose tends to nest them. */
const OPENERS = new Set(['(', '[', '{', '<', '"', "'", '`', '‘', '“']);

/**
 * Closers and sentence punctuation stripped from the right. A real path never
 * ends in any of these: an extension always has a character after its dot, and a
 * dotfile's dot is never last.
 */
const CLOSERS = new Set([
  ')',
  ']',
  '}',
  '>',
  '"',
  "'",
  '`',
  '’',
  '”',
  ',',
  ';',
  ':',
  '!',
  '?',
  '.'
]);

/** `scheme://` - left to the web-links addon, which already owns real URLs. */
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;

/**
 * A call-shaped wrapper around a path: the `Read(` of `Read(src/main/index.ts)`.
 *
 * This is how Claude Code labels most of its tool activity, which makes it the
 * single most common way a path reaches the screen in this app. The name cannot
 * contain a separator, so a genuine path is never mistaken for one of these.
 */
const CALL_PREFIX_RE = /^[A-Za-z_][\w.-]*\(/;

/**
 * Where a tool says which line it means. Two spellings are in wide use and both
 * appear in this app's own output: `a.ts:12:5` from ripgrep, eslint and most
 * unix tools, and `a.ts(12,5)` from tsc and MSBuild.
 *
 * Both are anchored to the end, so a drive letter's colon is never mistaken for
 * one of these.
 */
const LINE_COL_SUFFIX_RES = [/:(\d+)(?::(\d+))?$/, /\((\d+)(?:,(\d+))?\)$/];

/**
 * Does this look like a path at all? One of: a drive letter, `~`, an explicit
 * `./` or `../`, an absolute `/`, or a relative path carrying a separator.
 *
 * The last case is the loose one, so it asks for a little more: two or more
 * separators, a trailing one, or a single one with a dot in the final segment.
 * That admits `src/index.ts`, `a/b/c` and `docs/` while turning away `and/or`
 * and `either/or`.
 */
function looksLikePath(s: string): boolean {
  // A bare `~` is excluded along with everything else this short: every shell
  // prompt sitting in $HOME prints one, and underlining part of most prompt
  // lines to offer the user their own home folder is not worth it.
  if (s.length < 2) return false;
  if (URL_SCHEME_RE.test(s)) return false;
  if (isWindowsPath(s)) return true;
  if (/^~[\\/]/.test(s)) return true;
  if (/^\.{1,2}[\\/]/.test(s)) return true;
  // See the file's header: a network path must never become a candidate.
  if (isUncPath(s)) return false;
  if (s.startsWith('/')) return true;

  const separators = (s.match(/[\\/]/g) ?? []).length;
  if (separators === 0) return false;
  // Backslash-only relative paths are too ambiguous in printed text - escape
  // sequences, regexes and markdown all use them. Require a forward slash.
  if (!s.includes('/')) return false;
  if (separators >= 2) return true;
  // A trailing separator is an outright statement that this names a folder, and
  // it is the only thing that makes a one-segment relative path unambiguous -
  // `docs/` in a line of agent output is a path, `docs` on its own is a word.
  if (s.endsWith('/')) return true;
  const last = s.slice(s.lastIndexOf('/') + 1);
  return last.includes('.') && last.length > 1;
}

/** Both halves of the shape test, which are always wanted together. */
function isPathShaped(s: string): boolean {
  return looksLikePath(s) && segmentsAreSane(s);
}

/** Every segment of the candidate has to be plausible, or the whole thing is not one. */
function segmentsAreSane(s: string): boolean {
  const body = isWindowsPath(s) ? s.slice(2) : s;
  const parts = body.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length === 0) return body.length > 0 && /^[\\/]+$/.test(body);
  return parts.every((p) => p === '~' || p === '.' || p === '..' || SEGMENT_CHARS.test(p));
}

/**
 * What `ls -F` appends to say what kind of thing an entry is. None is part of
 * the name, and none may be part of the text that gets underlined. `/` is absent
 * because a trailing separator already means "folder" to the grammar above.
 */
const CLASSIFY_SUFFIXES = new Set(['*', '@', '=', '|']);

/**
 * The entry name `word` refers to, if any.
 *
 * This is the escape hatch from the separator rule in the header: a token with
 * nothing path-shaped about it is a path when the directory it would live in
 * actually holds something by that name. Membership answers what grammar cannot,
 * so the caller supplies the names and this stays as pure as everything else.
 */
function bareNameOf(word: string, names: ReadonlySet<string>): string | null {
  let name = word;
  if (name.length > 1 && CLASSIFY_SUFFIXES.has(name[name.length - 1])) {
    name = name.slice(0, -1);
  }
  if (name === '.' || name === '..') return null;
  if (!SEGMENT_CHARS.test(name)) return null;
  return names.has(name) ? name : null;
}

/** The trailing position on `word`, in whichever of the two spellings it uses. */
function matchLineColSuffix(word: string): RegExpExecArray | null {
  for (const re of LINE_COL_SUFFIX_RES) {
    const match = re.exec(word);
    if (match) return match;
  }
  return null;
}

/**
 * Find every path-shaped token in one line of terminal text.
 *
 * Whitespace splits the line into words; each word is then unwrapped from its
 * punctuation, checked for shape, and split from its `:line:col` suffix. Offsets
 * are tracked against the original string throughout, because the caller maps
 * them back onto terminal cells and an off-by-one there underlines the wrong
 * characters.
 */
/**
 * Strip what a path is wrapped in: enclosing punctuation, and the `Read(` of a
 * Claude Code tool label. The offset moves with it, so the caller's index stays
 * true to the original line.
 */
function unwrapOpeners(word: string, start: number): { word: string; start: number } {
  while (word.length > 0 && OPENERS.has(word[0])) {
    word = word.slice(1);
    start += 1;
  }
  const call = CALL_PREFIX_RE.exec(word);
  if (call) {
    word = word.slice(call[0].length);
    start += call[0].length;
  }
  return { word, start };
}

/**
 * Peel a trailing position and any closing punctuation off the end.
 *
 * The two interleave, because `)` is both a closer and part of tsc's
 * `a.ts(12,5)`. Peeling one layer at a time and retrying lets `(a.ts(12,5))`
 * come apart correctly, in either order.
 *
 * `isCandidate` decides whether a position may be taken at all: what is left
 * once the suffix is gone has to read as a path, so a lone `(12,5)` or a bare
 * `:80` is never mistaken for one.
 */
function peelTail(
  word: string,
  isCandidate: (s: string) => boolean
): { word: string; line?: number; col?: number } {
  let line: number | undefined;
  let col: number | undefined;

  for (;;) {
    const suffix = line === undefined ? matchLineColSuffix(word) : null;
    if (suffix && isCandidate(word.slice(0, suffix.index))) {
      word = word.slice(0, suffix.index);
      line = Number(suffix[1]);
      // The column group is optional in both spellings, so `at` rather than an
      // index: a missing group is genuinely undefined at runtime.
      const colText = suffix.at(2);
      col = colText === undefined ? undefined : Number(colText);
      continue;
    }
    if (word.length > 0 && CLOSERS.has(word[word.length - 1])) {
      word = word.slice(0, -1);
      continue;
    }
    break;
  }

  return {
    word,
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {})
  };
}

export function findCandidatePaths(
  lineText: string,
  dirEntryNames?: ReadonlySet<string>
): PathCandidate[] {
  const out: PathCandidate[] = [];

  // A token is a candidate by grammar or by the listing, and every test in here
  // wants both halves together.
  const isCandidate = (s: string): boolean =>
    isPathShaped(s) || (dirEntryNames !== undefined && bareNameOf(s, dirEntryNames) !== null);

  for (const match of lineText.matchAll(/\S+/g)) {
    const unwrapped = unwrapOpeners(match[0], match.index);
    const { word, line, col } = peelTail(unwrapped.word, isCandidate);

    // Grammar first, listing second. A classify suffix is part of the token and
    // not part of the name, so the text pushed is what `bareNameOf` returned -
    // the underline is measured from it.
    let text: string | null = isPathShaped(word) ? word : null;
    const bare = text === null && dirEntryNames !== undefined;
    if (bare) text = bareNameOf(word, dirEntryNames);
    if (text === null) continue;

    out.push({
      text,
      index: unwrapped.start,
      ...(bare ? { bare: true as const } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {})
    });
  }

  return out;
}

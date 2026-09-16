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
 * a drive letter). A bare `index.ts` is not matched. That loses the occasional
 * real filename, and it is still the right trade: without a separator there is
 * nothing to tell a filename from ordinary prose, so `v1.2.3`, `Node.js` and
 * `e.g.` would all become candidates and each would cost a `stat` to reject.
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
export function findCandidatePaths(lineText: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  const wordRe = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = wordRe.exec(lineText)) !== null) {
    let word = match[0];
    let start = match.index;

    while (word.length > 0 && OPENERS.has(word[0])) {
      word = word.slice(1);
      start += 1;
    }

    const call = CALL_PREFIX_RE.exec(word);
    if (call) {
      word = word.slice(call[0].length);
      start += call[0].length;
    }

    // Unwrapping and suffix-stripping interleave, because `)` is both a closer
    // and part of tsc's `a.ts(12,5)`. Peeling one layer at a time and retrying
    // lets `(a.ts(12,5))` come apart correctly, in either order.
    let line: number | undefined;
    let col: number | undefined;
    for (;;) {
      if (line === undefined) {
        const suffix = matchLineColSuffix(word);
        // Only honoured when what is left still reads as a path, so a lone
        // `(12,5)` or a bare `:80` is never mistaken for one.
        if (suffix && isPathShaped(word.slice(0, suffix.index))) {
          word = word.slice(0, suffix.index);
          line = Number(suffix[1]);
          // The column group is optional in both spellings, so `at` rather than
          // an index: a missing group is genuinely undefined at runtime.
          const colText = suffix.at(2);
          col = colText === undefined ? undefined : Number(colText);
          continue;
        }
      }
      if (word.length > 0 && CLOSERS.has(word[word.length - 1])) {
        word = word.slice(0, -1);
        continue;
      }
      break;
    }

    if (!isPathShaped(word)) continue;

    out.push({
      text: word,
      index: start,
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {})
    });
  }

  return out;
}

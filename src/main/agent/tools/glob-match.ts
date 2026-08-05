/**
 * Glob matching, for the `glob` tool and for every place a pattern filters
 * paths (`grep`'s `glob` argument, the ignore rules).
 *
 * Written out rather than taken from a package because the semantics have to be
 * exactly one thing and stay it: patterns are matched against a path relative to
 * the search root, written with forward slashes on every platform. `*` stops at
 * a separator, `**` crosses them, and a pattern with no separator in it matches
 * the file name anywhere in the tree - the rule that makes `*.ts` mean what
 * everyone expects it to mean.
 */

/** Characters that mean something to a RegExp and nothing to a glob. */
function escapeLiteral(char: string): string {
  return /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate one glob to a RegExp source, without anchors.
 *
 * `**` is handled with its trailing slash so that `src/**\/*.ts` also matches
 * `src/a.ts` - a `**` stands for any number of directories, including none.
 */
function translate(pattern: string): string {
  let out = '';
  let braces = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        const followedBySlash = pattern[i + 2] === '/';
        out += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      const body = pattern.slice(i + 1, end);
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
      continue;
    }
    if (char === '{') {
      braces++;
      out += '(?:';
      continue;
    }
    if (char === '}' && braces > 0) {
      braces--;
      out += ')';
      continue;
    }
    if (char === ',' && braces > 0) {
      out += '|';
      continue;
    }
    out += escapeLiteral(char);
  }
  return out;
}

/**
 * A matcher for `pattern`, against paths relative to the search root.
 *
 * A pattern with no `/` in it is matched against the file name as well, so
 * `*.ts` finds `src/main/index.ts` the way every other tool would. Pass
 * `matchBasename: false` to turn that off - an ignore rule written `/dist` is
 * about one folder, not about every folder called `dist`.
 */
export function globMatcher(
  pattern: string,
  options: { matchBasename?: boolean } = {}
): (relPath: string) => boolean {
  const full = new RegExp(`^${translate(pattern)}$`);
  const byName = options.matchBasename ?? !pattern.includes('/');
  if (!byName) return (relPath) => full.test(relPath);

  return (relPath) => full.test(relPath) || full.test(relPath.split('/').pop() ?? '');
}

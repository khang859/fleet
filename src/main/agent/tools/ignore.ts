import { globMatcher } from './glob-match';

/**
 * `.gitignore` rules, enough of them to walk a real repository.
 *
 * Honouring them is not politeness - it is the difference between a search that
 * reads a project and one that reads `node_modules`. The subset here is the part
 * that actually appears in ignore files: comments, negation, directory-only
 * rules, anchoring, and globs. Escapes and trailing-space subtleties are not
 * handled, and would only change which of two ignored files is ignored.
 */

export type IgnoreRule = {
  negated: boolean;
  /** `build/` ignores the directory; `build` ignores a file of that name too. */
  dirOnly: boolean;
  matches: (relPath: string) => boolean;
};

/** Never walked into, whatever the ignore files say. */
export const ALWAYS_SKIPPED = new Set(['.git']);

export function parseIgnoreRules(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    const body = negated ? line.slice(1) : line;
    const dirOnly = body.endsWith('/');
    const trimmed = dirOnly ? body.slice(0, -1) : body;
    if (trimmed === '') continue;

    // A leading slash anchors the rule to the ignore file's own folder and is
    // not part of the pattern. A slash anywhere else anchors it too - that is
    // git's rule, and it is what makes `/dist` mean this `dist` and `dist`
    // mean any of them.
    const anchored = trimmed.startsWith('/') || trimmed.slice(0, -1).includes('/');
    const pattern = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    rules.push({
      negated,
      dirOnly,
      matches: globMatcher(pattern, { matchBasename: !anchored })
    });
  }
  return rules;
}

/**
 * Whether these rules ignore `relPath`, or `null` when none of them mention it.
 *
 * Last match wins, which is what makes `!keep.log` after `*.log` work.
 */
export function ignoreDecision(
  rules: IgnoreRule[],
  relPath: string,
  isDir: boolean
): boolean | null {
  let decision: boolean | null = null;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.matches(relPath)) decision = !rule.negated;
  }
  return decision;
}

/**
 * The ignore files seen so far on the way down a tree, each with the folder it
 * was found in. A rule only applies to paths below its own folder, so the scope
 * has to travel with it.
 */
export type IgnoreScope = { dir: string; rules: IgnoreRule[] };

/** Whether the accumulated scopes ignore a path, deepest rule set last. */
export function isIgnored(scopes: IgnoreScope[], relPath: string, isDir: boolean): boolean {
  let decision = false;
  for (const scope of scopes) {
    const scoped = scope.dir === '' ? relPath : relPath.slice(scope.dir.length + 1);
    const verdict = ignoreDecision(scope.rules, scoped, isDir);
    if (verdict !== null) decision = verdict;
  }
  return decision;
}

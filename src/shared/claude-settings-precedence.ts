import type { ClaudeConfigScope } from './claude-config';
import { isListKey } from './claude-settings-schema';
import { isRecord } from './is-record';

/**
 * How a settings key resolves when more than one file sets it.
 *
 * The naive model - "the narrowest file wins" - is wrong for most of what a
 * developer actually edits. Claude Code's documented rules are three:
 *
 * - Scalars: the narrowest file that sets the key wins (local, then project,
 *   then user).
 * - **Lists merge.** "When you set the same list key, such as
 *   `permissions.allow`, in more than one file, Claude Code combines the lists
 *   instead of picking one." Reporting a list as overridden would tell the
 *   user their other file's rules stopped applying, which is false.
 * - Four model-related keys follow neither rule and are not reported on at all.
 *
 * Everything here compares *three files*. Managed settings, `--settings`, CLI
 * flags and environment variables can all change the effective value without
 * appearing in any of them, so callers must present these results as a
 * file comparison, never as the effective value.
 */

/** Narrowest first - the order a scalar key's winner is looked up in. */
export const SCOPE_PRECEDENCE: ClaudeConfigScope[] = ['projectLocal', 'project', 'user'];

/** Human labels for the three files, for notices that name one. */
export const SCOPE_LABELS: Record<ClaudeConfigScope, string> = {
  user: 'User settings',
  project: 'Shared project settings',
  projectLocal: 'Project local settings'
};

/**
 * Keys whose resolution is neither "narrowest wins" nor "combine".
 *
 * `fallbackModel` is an ordered chain taken whole from the highest file that
 * sets it. `modelPicker` is taken whole and ignored entirely in project and
 * local settings. `availableModels` merges across non-managed scopes but is
 * replaced outright by a managed list. `modelSettings` resolves per model,
 * together with `effortLevel`. None of these can be expressed as a verdict
 * over three files, so the page shows none and links to the docs instead.
 */
export const SPECIAL_KEYS = new Set([
  'fallbackModel',
  'modelPicker',
  'availableModels',
  'modelSettings'
]);

export type KeyClass = 'scalar' | 'list' | 'special';

/** Which of the three resolution rules applies to a key. */
export function classifyKey(path: string[]): KeyClass {
  if (path.length > 0 && SPECIAL_KEYS.has(path[0])) return 'special';
  return isListKey(path) ? 'list' : 'scalar';
}

/** The three files' parsed contents. A file that is absent or unparsed is `undefined`. */
/**
 * Each file's whole parsed object, keyed by scope. Not the value at the key -
 * `describePrecedence` walks the path itself, and a caller that extracts first
 * makes every key look unset. Typed as a record so that mistake is a type
 * error rather than a silent empty report.
 */
export type ScopeValues = Partial<Record<ClaudeConfigScope, Record<string, unknown>>>;

export type PrecedenceResult =
  /** No visible file sets the key. */
  | { kind: 'unset' }
  /** Exactly one file sets it, so nothing competes. */
  | { kind: 'only'; scope: ClaudeConfigScope }
  /** A scalar set in several files; `winner` is the one Claude Code uses. */
  | { kind: 'overridden'; winner: ClaudeConfigScope; losers: ClaudeConfigScope[] }
  /** A list set in several files; every contributor's entries apply. */
  | { kind: 'combined'; contributors: ClaudeConfigScope[] }
  /** A key whose own rule a three-file comparison cannot express. */
  | { kind: 'special'; scopes: ClaudeConfigScope[] };

export function valueAtPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Whether a file sets this key to anything at all. */
function setsKey(fileValue: unknown, path: string[]): boolean {
  return valueAtPath(fileValue, path) !== undefined;
}

/**
 * How a key resolves across the three visible files.
 *
 * Scopes are reported narrowest-first everywhere, so a caller can render the
 * list without re-sorting it.
 */
export function describePrecedence(path: string[], values: ScopeValues): PrecedenceResult {
  const setting = SCOPE_PRECEDENCE.filter((scope) => setsKey(values[scope], path));

  if (setting.length === 0) return { kind: 'unset' };

  const keyClass = classifyKey(path);
  if (keyClass === 'special') return { kind: 'special', scopes: setting };
  if (setting.length === 1) return { kind: 'only', scope: setting[0] };
  if (keyClass === 'list') return { kind: 'combined', contributors: setting };

  return { kind: 'overridden', winner: setting[0], losers: setting.slice(1) };
}

/**
 * The caveat that belongs on every precedence notice.
 *
 * The page reads three files. It does not read managed settings, the flags a
 * terminal was launched with, or the user's shell - and `ANTHROPIC_MODEL`
 * exported in a shell beats the `model` key from any file. Saying so is the
 * difference between a useful hint and a confident wrong answer.
 */
export const PRECEDENCE_CAVEAT =
  'Compares these three files only. Managed settings, --settings, command-line flags and environment variables can change the value in a session without appearing here.';

/**
 * The whole precedence model in one sentence, stated once at the top of the page.
 *
 * One rule a user learns on arrival beats the same rule restated under a dozen
 * controls, and the override/combine asymmetry is the part that has to be said
 * out loud - nothing about the controls themselves reveals it.
 */
export const PRECEDENCE_SENTENCE =
  'Project local overrides Shared project, which overrides User. List values such as the permission rules combine across all three instead of overriding.';

/** The standing note that belongs on any permission list. */
export const DENY_FIRST_NOTE =
  'A deny rule in any of these files blocks a matching allow rule in any other, in either direction.';

/**
 * Scopes that cannot make `permissions.defaultMode` take effect for two values.
 *
 * Claude Code ignores `auto` and `bypassPermissions` when they come from
 * project or local settings. Saving one there is not an error, it just does
 * nothing, which is exactly the kind of dead end a settings page should name.
 */
export const DEFAULT_MODE_USER_ONLY_VALUES = ['auto', 'bypassPermissions'];

export function isIneffectiveDefaultMode(scope: ClaudeConfigScope, value: string): boolean {
  return scope !== 'user' && DEFAULT_MODE_USER_ONLY_VALUES.includes(value);
}

/**
 * What Claude Code ends up using for one key, and where each part came from.
 *
 * The page's whole teaching problem is that two rules operate at once: a scalar
 * is *replaced* by a narrower file, a list is *added to* by every file. Prose
 * about that is read by nobody. Showing the resolved value with its sources
 * attached demonstrates the asymmetry instead of asserting it.
 *
 * Same caveat as everything else here: three files only. `PRECEDENCE_CAVEAT`
 * must travel with any rendering of this.
 */
export type EffectiveValue =
  /** No visible file sets the key. */
  | { kind: 'unset' }
  /** One value wins. `losers` are the files whose value is discarded. */
  | { kind: 'replaced'; value: unknown; winner: ClaudeConfigScope; losers: ClaudeConfigScope[] }
  /** Every contributing file's entries apply, in narrowest-first order. */
  | { kind: 'combined'; parts: Array<{ scope: ClaudeConfigScope; entries: unknown[] }> }
  /** A key whose own rule a three-file comparison cannot express. */
  | { kind: 'special'; scopes: ClaudeConfigScope[] };

export function resolveEffective(path: string[], values: ScopeValues): EffectiveValue {
  const result = describePrecedence(path, values);

  switch (result.kind) {
    case 'unset':
      return { kind: 'unset' };
    case 'special':
      return { kind: 'special', scopes: result.scopes };
    case 'combined':
      return {
        kind: 'combined',
        parts: result.contributors.map((scope) => ({
          scope,
          // A list key holding a non-array is malformed rather than absent, so
          // it contributes nothing instead of throwing the whole row away.
          entries: asArray(valueAtPath(values[scope], path))
        }))
      };
    case 'only': {
      const value = valueAtPath(values[result.scope], path);
      return classifyKey(path) === 'list'
        ? { kind: 'combined', parts: [{ scope: result.scope, entries: asArray(value) }] }
        : { kind: 'replaced', value, winner: result.scope, losers: [] };
    }
    case 'overridden':
      return {
        kind: 'replaced',
        value: valueAtPath(values[result.winner], path),
        winner: result.winner,
        losers: result.losers
      };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

import { splitShellCommand } from '../../../shared/shell-split';

// Conservative read-only classifier for auto mode. `true` means every
// subcommand is a known observe-only program with no way to write files,
// execute arbitrary code, or leak credentials — so it can run without a
// prompt even when no OS sandbox is available. Anything unrecognized is
// `false`, and the caller falls back to a prompt: a miss is never unsafe,
// it's just one more click.

/** Programs that only observe (given no output redirection, screened below). */
const SAFE_COMMANDS = new Set([
  'ls',
  'pwd',
  'whoami',
  'uname',
  'date',
  'uptime',
  'hostname',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'which',
  'type',
  'echo',
  'printf',
  'printenv',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'tree',
  'grep',
  'rg',
  'diff',
  'cmp',
  'od',
  'strings',
  'jq',
  'ps'
]);

/** git subcommands that only read repo state, with any flags. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'ls-files',
  'grep'
]);

/** find(1) flags that delete or execute; their presence makes find mutating. */
const FIND_MUTATING_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls'
]);

/**
 * Credential locations a no-prompt command must never touch, mirroring the
 * read_file denies in fs-safety.ts (which bash paths would otherwise bypass).
 * A match only forces a prompt, so over-matching is acceptable.
 */
const SENSITIVE_ARG =
  /\.ssh|\.aws|\.gnupg|\.config[/\\]gh|\.netrc|\.npmrc|\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b/;

/**
 * Whether `raw` is a purely read-only command line: every piped/chained
 * subcommand (and command substitution) is a known observe-only program,
 * with no output redirection, process substitution, or credential-path args.
 */
export function isReadOnlyBashCommand(raw: string): boolean {
  if (hasUnquotedWriteMeta(raw)) return false;
  if (SENSITIVE_ARG.test(raw)) return false;
  const parts = splitShellCommand(raw);
  if (parts.length === 0) return false;
  return parts.every(isReadOnlySubcommand);
}

function isReadOnlySubcommand(cmd: string): boolean {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return false;
  if (first === 'git') {
    // First non-flag token is read as the subcommand. `git -C dir status`
    // conservatively reads `dir` as the subcommand and falls back to a prompt.
    const sub = tokens.slice(1).find((t) => !t.startsWith('-'));
    return sub !== undefined && SAFE_GIT_SUBCOMMANDS.has(sub);
  }
  if (first === 'find') return !tokens.some((t) => FIND_MUTATING_FLAGS.has(t));
  return SAFE_COMMANDS.has(first);
}

/**
 * Detect unquoted `>` (any output redirection, incl. `>>`, `2>`, `&>`) and
 * `<(`/`>(` process substitutions (they execute a nested command that
 * splitShellCommand does not extract). Quote-aware so `grep '>' f` is fine.
 */
function hasUnquotedWriteMeta(raw: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return true;
    if (c === '<' && raw[i + 1] === '(') return true;
  }
  return false;
}

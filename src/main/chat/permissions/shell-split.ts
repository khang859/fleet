// Operator-aware shell splitting for the permission gate.
//
// Security boundary: a single `bash` invocation may chain many commands
// (`a && b`, `a; b`, `a | b`, `$(c)`, `` `d` ``). Every one of those
// subcommands must independently clear the allowlist — otherwise an attacker
// smuggles `rm -rf x` past an `echo *` allow via `echo a && rm -rf x`.
//
// We do NOT attempt a full POSIX parse. We split on shell control operators
// while respecting single/double quotes, surface command substitutions as
// their own subcommands, and strip benign wrappers so the real command is
// what gets matched.

/** Wrappers that prefix another command; we strip them so the inner command matches. */
const WRAPPERS = new Set([
  'timeout',
  'nice',
  'nohup',
  'xargs',
  'env',
  'sudo',
  'command',
  'builtin',
  'time',
  'stdbuf',
  'setsid',
  'ionice'
]);

/**
 * Split a raw shell command line into the list of subcommands that must each
 * match the allowlist. Quote-aware; extracts `$(...)` and backtick
 * substitutions as separate subcommands (recursively). Returns trimmed,
 * non-empty subcommands.
 */
export function splitShellCommand(raw: string): string[] {
  const segments = splitOnOperators(raw);
  const out: string[] = [];
  for (const seg of segments) {
    const { command, substitutions } = extractSubstitutions(seg);
    // Substitutions run first / independently — gate them too.
    for (const sub of substitutions) out.push(...splitShellCommand(sub));
    const stripped = stripWrappers(command.trim());
    if (stripped) out.push(stripped);
  }
  return out;
}

/**
 * Split on `&&`, `||`, `;`, `|`, `&`, and newlines, ignoring operators inside
 * single or double quotes. Redirections and the trailing background `&` are
 * treated as separators (the right side becomes its own — possibly empty —
 * segment which is dropped if blank).
 */
function splitOnOperators(raw: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];

    if (quote) {
      current += c;
      if (c === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '\n' || c === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if ((c === '&' || c === '|') && next === c) {
      // && or ||
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      // single pipe or background
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Pull `$(...)` and `` `...` `` command substitutions out of a segment.
 * Returns the segment with the substitution text removed plus the list of
 * inner command strings. Quote-aware so `'$(x)'` literals are left alone.
 */
function extractSubstitutions(seg: string): { command: string; substitutions: string[] } {
  const substitutions: string[] = [];
  let command = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];

    if (quote === "'") {
      // single quotes suppress substitution
      command += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === "'" && quote === null) {
      quote = "'";
      command += c;
      continue;
    }
    if (c === '"' && quote === null) {
      quote = '"';
      command += c;
      continue;
    }
    if (c === '"' && quote === '"') {
      quote = null;
      command += c;
      continue;
    }

    if (c === '$' && seg[i + 1] === '(') {
      const end = matchParen(seg, i + 1);
      if (end !== -1) {
        substitutions.push(seg.slice(i + 2, end));
        i = end;
        continue;
      }
    }
    if (c === '`') {
      const end = seg.indexOf('`', i + 1);
      if (end !== -1) {
        substitutions.push(seg.slice(i + 1, end));
        i = end;
        continue;
      }
    }
    command += c;
  }
  return { command, substitutions };
}

/** Find the index of the `)` matching the `(` at `open`, honoring nesting. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip leading wrapper commands (`timeout 5 npm test` → `npm test`).
 * Drops the wrapper token and its option flags / numeric args until the real
 * command token, then returns the remainder. Also drops leading `VAR=val`
 * environment assignments.
 */
function stripWrappers(cmd: string): string {
  const trimmed = cmd.trim();
  let tokens = tokenize(trimmed);
  const first = tokens[0];
  if (!first) return '';
  const isEnvAssign = /^[A-Za-z_][A-Za-z0-9_]*=/.test(first);
  // Fast path: no wrapper / env-assignment to strip — return the command
  // verbatim so quotes and spacing are preserved in the matched/displayed text.
  if (!isEnvAssign && !WRAPPERS.has(first)) return trimmed;

  // Drop leading env-var assignments (`FOO=bar cmd`).
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);

  while (tokens.length && WRAPPERS.has(tokens[0])) {
    // Drop the wrapper and any of its flags / numeric durations until we reach
    // the next bareword that looks like a command.
    let i = 1;
    while (i < tokens.length && (tokens[i].startsWith('-') || /^[0-9]/.test(tokens[i]))) i++;
    tokens = tokens.slice(i);
  }
  return tokens.join(' ');
}

/** Whitespace tokenizer that keeps quoted spans intact. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

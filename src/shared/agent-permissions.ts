import { splitShellCommand, splitShellSegments, tokenizeCommand, WRAPPERS } from './shell-split';

/**
 * Which shell commands the agent may run without stopping to ask.
 *
 * Everything the agent does runs the moment it is asked for, with one
 * exception: `bash` is the tool with no sandbox, so a command goes through
 * here first. The other tools cannot leave the working folder, and `terminal`
 * is already the user pressing Enter.
 *
 * Nothing here ever blocks a command outright. The strongest thing this file
 * can say is "ask the user", and the user can always say yes. What it protects
 * is the difference between a person deciding and a model deciding.
 */

/** Command patterns the user has settled, both buckets empty by default. */
export type AgentPermissionRules = {
  /** Runs without asking. `npm run` covers `npm run build`. */
  allow: string[];
  /** Refused without asking. Written by the user, never by Fleet. */
  deny: string[];
};

export const DEFAULT_AGENT_PERMISSION_RULES: AgentPermissionRules = { allow: [], deny: [] };

/**
 * What to do with a command.
 *
 * `unknown` is the interesting one: no rule had anything to say about it, which
 * is the case a classifier is for. Until there is one, it asks.
 */
export type CommandVerdict =
  | { kind: 'allow' }
  | { kind: 'deny' }
  /** `remember` is false when a rule could never cover this command anyway. */
  | { kind: 'ask'; reason: string; remember: boolean }
  | { kind: 'unknown' };

/**
 * Match a command against a rule pattern.
 *
 * `*` is the only wildcard. A pattern that does not end in one matches the
 * command exactly or as a whitespace-delimited prefix, so `git` matches
 * `git status` and never `github`.
 */
export function matchCommand(pattern: string, command: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;
  const body = trimmed.split('*').map(escapeRegex).join('.*');
  const boundary = trimmed.endsWith('*') ? '' : '(?:\\s|$)';
  return new RegExp(`^${body}${boundary}`).test(command.trim());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What should happen to `command`, given the rules the user has settled.
 *
 * A command line is rarely one command, so it is split first and every part is
 * judged: one denied part denies the line, one part worth asking about asks
 * about the line, and the line only runs unasked when every part is allowed.
 * Otherwise `echo hi && rm -rf ~` rides in on an `echo` rule.
 *
 * Order is deny, then ask, then allow. Ask sits above allow deliberately: a
 * broad rule the user picked up by clicking "always allow" on `git push` must
 * not go on to cover `git push --force`.
 */
export function decideCommand(rules: AgentPermissionRules, command: string): CommandVerdict {
  const parts = splitShellCommand(command);

  if (parts.some((part) => rules.deny.some((rule) => matchCommand(rule, part)))) {
    return { kind: 'deny' };
  }

  // Against the subcommands as they were written, which is a different list
  // from the one the rules are matched against: getting a part a rule can match
  // means dropping `sudo`, and `sudo` is exactly what this looks for.
  const reason = alwaysAskReason(command);
  if (reason !== null) return { kind: 'ask', reason, remember: false };

  // Nothing left that a rule could be about, which no rule can therefore
  // settle. Every command reaching here has already cleared the checks above.
  if (parts.length === 0) return { kind: 'unknown' };

  if (parts.every((part) => rules.allow.some((rule) => matchCommand(rule, part)))) {
    return { kind: 'allow' };
  }
  return { kind: 'unknown' };
}

/*
 * The commands that always come to the user.
 *
 * Not a blocklist: every one of these runs the moment the user says so. They
 * are the handful where the cost of being wrong is not a bad edit but a
 * rewritten remote, a leaked key or a machine-wide change, and so are the ones
 * that should never be approved on the strength of a model's opinion. One
 * keypress, every time.
 */

/** Credential stores. Matched per token, so a path is not confused with prose. */
const CREDENTIAL_PATH =
  /\.ssh|\.aws|\.gnupg|\.config\/gh|\.netrc|\.npmrc|\.env\b|Keychains|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.p12\b|\.pfx\b/;

/** Running as somebody else, wherever on the line it is spelled. */
const PRIVILEGE = new Set(['sudo', 'doas', 'su']);

/** Anything piped into something that runs what it is handed. */
const PIPE_TO_SHELL =
  /\|\s*(?:sudo\s+)?(?:[\w./-]*\/)?(?:bash|sh|zsh|ksh|fish|dash|python[23]?|perl|ruby|node)\b/;

/**
 * Programs whose argument is a program of its own.
 *
 * Nothing about what one of these will do can be read off the line, because the
 * part that says is a quoted string or a file. They are not always-ask - most
 * of what an agent runs is a script - but no rule may be minted from one, since
 * a rule naming the interpreter grants everything it could ever be handed.
 */
const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'ksh',
  'fish',
  'dash',
  'eval',
  'source',
  'python',
  'python2',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
  'osascript',
  'ssh'
]);

/**
 * A path that is not inside the working folder.
 *
 * A relative path is the working folder, which is what the agent is for. An
 * absolute one, a home path, a climb out of it, or the unexpanded variable that
 * stands for home is somewhere else - and the variable matters, because nothing
 * here expands anything.
 */
const OUTSIDE = /^([/~]|\.\.|\$\{?HOME\b)/;

/** Redirection targets that discard rather than write. */
const DISCARDS = /^\/dev\/(null|stdout|stderr|fd\/\d+)$/;

/**
 * Why this command has to be asked about, or null when it does not.
 *
 * Works from the subcommands as written rather than the raw line, because a
 * regex over the raw line cannot tell `sudo rm -rf /` from a commit message
 * mentioning one, and cannot find the `sudo` in `ls\nsudo rm -rf /` at all.
 */
export function alwaysAskReason(
  command: string,
  segments = splitShellSegments(command)
): string | null {
  const invocations = segments.map(invocation).filter((inv) => inv !== null);

  if (invocations.some((inv) => [...inv.wrappers, inv.program].some((w) => PRIVILEGE.has(w)))) {
    return 'Runs as root.';
  }
  if (PIPE_TO_SHELL.test(command)) return 'Pipes into a shell, which runs whatever comes back.';
  // Per token, so a quoted phrase mentioning `.env` is prose rather than a
  // path - and so `~/.ss""h/id_rsa`, which is one path once the quotes are
  // gone, is not two harmless-looking halves.
  for (const inv of invocations) {
    for (const token of inv.args) {
      if (!/\s/.test(token) && CREDENTIAL_PATH.test(token)) return 'Touches credentials.';
    }
  }

  for (const [i, inv] of invocations.entries()) {
    const reason = invocationReason(inv, i < invocations.length - 1);
    if (reason !== null) return reason;
  }
  return null;
}

/** One subcommand, told apart from the wrappers standing in front of it. */
type Invocation = { wrappers: string[]; program: string; args: string[] };

/**
 * What a segment actually invokes.
 *
 * `env FOO=1 sudo -u root npm test` runs `npm`, through `env` and `sudo`. The
 * wrappers are kept rather than dropped, because which ones were used is itself
 * worth knowing - `sudo` is one of them.
 */
function invocation(segment: string): Invocation | null {
  const tokens = tokenizeCommand(segment);
  const wrappers: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    // `FOO=bar cmd` sets something for the command rather than being one.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i++;
      continue;
    }
    const word = basename(tokens[i]);
    if (!WRAPPERS.has(word)) return { wrappers, program: word, args: tokens.slice(i + 1) };
    wrappers.push(word);
    // Step over the wrapper's own flags and numeric arguments (`timeout 5 x`).
    i++;
    while (i < tokens.length && (tokens[i].startsWith('-') || /^[0-9]/.test(tokens[i]))) i++;
  }
  // Nothing but wrappers, which `sudo -v` is: no program, still worth knowing.
  return wrappers.length === 0 ? null : { wrappers, program: '', args: [] };
}

/** `/usr/bin/sudo` is `sudo`; a path is not a disguise. */
function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

function invocationReason(inv: Invocation, hasFollowing: boolean): string | null {
  for (const target of redirectTargets(inv.args)) {
    if (OUTSIDE.test(target) && !DISCARDS.test(target)) {
      return 'Writes to a file outside the working folder.';
    }
  }

  // An interpreter's `-c` argument is another command line, and "some commands
  // always ask" has to survive being written inside quotes. No rule can be
  // minted over an interpreter, so reaching here takes a hand-written one -
  // which is still not consent to the `sudo` hiding in the string.
  if (INTERPRETERS.has(inv.program)) {
    const flag = inv.args.findIndex((t) => t === '-c' || t === '-e');
    const code = flag === -1 ? undefined : inv.args[flag + 1];
    if (code !== undefined) return alwaysAskReason(code);
  }

  if (inv.program === 'rm') {
    const recursive = inv.args.some((t) => /^-[a-zA-Z]*r/.test(t) || t === '--recursive');
    const outside = inv.args.some((t) => !t.startsWith('-') && OUTSIDE.test(t));
    if (recursive && outside) return 'Deletes a folder outside the working folder.';
  }

  // Moving first makes every relative path after it relative to somewhere
  // else, so `cd / && rm -rf tmp` is not the local delete it reads as.
  if (inv.program === 'cd' && hasFollowing && inv.args.some((t) => OUTSIDE.test(t))) {
    return 'Runs somewhere other than the working folder.';
  }

  if (inv.program === 'git') return gitReason(inv.args);

  return null;
}

function gitReason(args: string[]): string | null {
  // `git -C <path>` and `git -c <name>=<value>` take a value, and stepping over
  // only the flag leaves that value sitting where the subcommand should be.
  let i = 0;
  while (i < args.length) {
    if (args[i] === '-C' || args[i] === '-c') {
      i += 2;
      continue;
    }
    if (!args[i].startsWith('-')) break;
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const flags = rest.filter((t) => t.startsWith('-'));

  if (sub === 'push') {
    const forced =
      flags.some((f) => f === '-f' || f.startsWith('--force') || f === '--mirror') ||
      // `+main:main` is a force push spelled as a refspec, with no flag to find.
      rest.some((t) => t.startsWith('+'));
    if (forced) return 'Force-pushes, which rewrites what is already on the remote.';
    if (flags.some((f) => f === '-d' || f === '--delete')) {
      return 'Deletes a branch from the remote.';
    }
  }
  if (sub === 'reset' && flags.includes('--hard')) return 'Throws away uncommitted work.';
  if (sub === 'clean' && flags.some((f) => /^-[a-zA-Z]*[fx]/.test(f))) {
    return 'Deletes files that were never committed.';
  }
  return null;
}

/**
 * The files a segment writes to, spacing and file descriptor aside: `> f`,
 * `>>f` and `2> f` all name one. Redirections are not separators, so this is
 * the only place the target of one is ever looked at.
 */
function redirectTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (const [i, arg] of args.entries()) {
    const match = /^\d*>>?(.*)$/.exec(arg);
    if (match === null) continue;
    const target = match[1] === '' ? args.at(i + 1) : match[1];
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

/**
 * The rule an "always allow" click should leave behind.
 *
 * The program and its subcommand, which is the unit people mean: `npm run
 * build` earns `npm run`, and `git status` earns `git status` rather than the
 * whole of git. No trailing wildcard, because a pattern already matches on a
 * word boundary - `npm run` covers `npm run test` and bare `npm run` both,
 * where `npm run *` would miss the second.
 *
 * Never the program on its own. `rm -rf node_modules` has no subcommand, and
 * answering it with `rm` would hand over every delete on the machine on the
 * strength of a click about one folder - so where there is no prefix that is
 * both safe and accurate, the rule is the line exactly as written. Narrow, but
 * honest about what was agreed to, and still enough to stop the next repeat.
 */
export function suggestRule(command: string): string | null {
  const parts = splitShellCommand(command);
  // A chained line has no single rule to remember: `a && b` would need one for
  // each, and inventing both from one click is not the user's decision.
  if (parts.length !== 1) return null;

  const tokens = tokenizeCommand(parts[0]);
  if (tokens.length === 0) return null;
  const program = tokens[0];
  if (INTERPRETERS.has(basename(program))) return null;

  const sub = tokens.slice(1).find((t) => !t.startsWith('-'));
  const prefix = sub === undefined ? program : `${program} ${sub}`;
  // A prefix with flags sitting inside it - `rm node_modules` against `rm -rf
  // node_modules` - is a rule that would never fire, and the program alone is
  // broader than what the user was looking at. Both come back to the line.
  return prefix !== program && matchCommand(prefix, parts[0]) ? prefix : parts[0];
}

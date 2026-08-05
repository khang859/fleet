import { splitShellCommand } from './shell-split';

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

  // Against the line as it was written, before any of it is judged part by
  // part. Splitting drops what it cannot use - `sudo -v` strips down to
  // nothing at all - and what it drops is exactly what this looks for.
  const reason = alwaysAskReason(command, parts);
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

/** Credential stores. Matched against the whole line, since any of it may read one. */
const CREDENTIAL_PATH =
  /\.ssh|\.aws|\.gnupg|\.config\/gh|\.netrc|\.npmrc|\.env\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.p12\b|\.pfx\b/;

/** `sudo x`, and after a separator so `a && sudo b` is caught too. */
const PRIVILEGED = /(?:^|[;&|(]\s*)\s*(?:sudo|doas|su)\s/;

/** Anything piped into a shell: the download half is not what makes it worth asking. */
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:bash|sh|zsh|ksh|fish)\b/;

/** Why this command has to be asked about, or null when it does not. */
export function alwaysAskReason(
  command: string,
  parts = splitShellCommand(command)
): string | null {
  if (PRIVILEGED.test(command)) return 'Runs as root.';
  if (PIPE_TO_SHELL.test(command)) return 'Pipes into a shell, which runs whatever comes back.';
  if (CREDENTIAL_PATH.test(command)) return 'Touches credentials.';
  for (const part of parts) {
    const reason = subcommandReason(part);
    if (reason !== null) return reason;
  }
  return null;
}

function subcommandReason(part: string): string | null {
  const tokens = part.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;

  if (first === 'rm') {
    const recursive = rest.some((t) => /^-[a-zA-Z]*r/.test(t) || t === '--recursive');
    // A relative path is the working folder, which is what the agent is for.
    // An absolute one, a home path or a climb out of it is somewhere else.
    const outside = rest.some((t) => !t.startsWith('-') && /^([/~]|\.\.)/.test(t));
    if (recursive && outside) return 'Deletes a folder outside the working folder.';
  }

  if (first === 'git') {
    const sub = rest.find((t) => !t.startsWith('-'));
    const flags = rest.filter((t) => t.startsWith('-'));
    if (sub === 'push' && flags.some((f) => f === '-f' || f.startsWith('--force'))) {
      return 'Force-pushes, which rewrites what is already on the remote.';
    }
    if (sub === 'reset' && flags.includes('--hard')) return 'Throws away uncommitted work.';
  }

  return null;
}

/**
 * The rule an "always allow" click should leave behind.
 *
 * The program and its subcommand, which is the unit people mean: `npm run
 * build` earns `npm run`, and `git status` earns `git status` rather than the
 * whole of git. No trailing wildcard, because a pattern already matches on a
 * word boundary - `npm run` covers `npm run test` and bare `npm run` both,
 * where `npm run *` would miss the second.
 */
export function suggestRule(command: string): string | null {
  const parts = splitShellCommand(command);
  // A chained line has no single rule to remember: `a && b` would need one for
  // each, and inventing both from one click is not the user's decision.
  if (parts.length !== 1) return null;

  const tokens = parts[0].split(/\s+/).filter(Boolean);
  const prefix: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    prefix.push(token);
    if (prefix.length === 2) break;
  }
  return prefix.length === 0 ? null : prefix.join(' ');
}

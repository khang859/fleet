import type { PermissionRules, PermissionVerdict } from '../../../shared/chat-permissions';
import { splitShellCommand } from './shell-split';

/** A parsed rule: a tool name and a glob pattern (`*` is the only wildcard). */
export type ParsedRule = { tool: string; pattern: string };

/**
 * Parse `Tool(pattern)` syntax. A bare `Tool` (no parens) means `Tool(*)`.
 * Returns null for malformed rules so a typo can't silently widen access.
 */
export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(trimmed);
  if (m) return { tool: m[1], pattern: m[2].trim() };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { tool: trimmed, pattern: '*' };
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Glob match with prefix word-boundary semantics:
 * - `*` matches any run of characters.
 * - A pattern that does NOT end in `*` matches the value exactly OR as a
 *   whitespace-delimited prefix — so `git` matches `git` and `git status`
 *   but never `github`.
 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '') return true;
  const body = pattern.split('*').map(escapeRegex).join('.*');
  const boundary = pattern.endsWith('*') ? '' : '(?:\\s|$)';
  return new RegExp(`^${body}${boundary}`).test(value);
}

/** Does any rule in `rules` match this (tool, value) pair? */
function matchesAny(rules: string[], tool: string, value: string): boolean {
  for (const raw of rules) {
    const parsed = parseRule(raw);
    if (parsed?.tool !== tool) continue;
    if (matchPattern(parsed.pattern, value)) return true;
  }
  return false;
}

/**
 * Evaluate a tool call against the rule set.
 *
 * Precedence (deny → ask → allow, first match wins, deny beats allow):
 * - For `Bash`, the command is split into its constituent subcommands and each
 *   is evaluated independently. ANY subcommand hitting a deny rule → deny.
 *   ANY subcommand hitting an ask rule (and no deny) → ask. The call is only
 *   auto-allowed when EVERY subcommand matches an allow rule.
 * - For any other tool, the value is the single argument string.
 * - The default verdict for anything not explicitly allowed is `ask` — the
 *   allowlist is the boundary; nothing is auto-allowed by omission.
 */
export function evaluatePermission(
  rules: PermissionRules,
  tool: string,
  value: string
): PermissionVerdict {
  const parts = tool === 'Bash' ? splitShellCommand(value) : [value];
  // An empty/unparseable bash line is treated as needing approval.
  if (parts.length === 0) return 'ask';

  // Deny wins if ANY part is denied.
  if (parts.some((p) => matchesAny(rules.deny, tool, p))) return 'deny';
  // Ask if ANY part is in the ask bucket.
  if (parts.some((p) => matchesAny(rules.ask, tool, p))) return 'ask';
  // Allow only if EVERY part is explicitly allowed.
  if (parts.every((p) => matchesAny(rules.allow, tool, p))) return 'allow';
  return 'ask';
}

/**
 * Derive the prefix an "Allow & remember" click should persist. For a bash
 * command we keep the leading non-flag tokens (the program + subcommand, e.g.
 * `npm run` from `npm run build`); for other tools we use the whole value.
 * Returns a rule string like `Bash(npm run *)`.
 */
export function suggestRememberRule(tool: string, value: string): string {
  if (tool !== 'Bash') return `${tool}(${value})`;
  const tokens = value.trim().split(/\s+/);
  const prefix: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('-')) break; // stop at the first flag
    prefix.push(t);
    if (prefix.length >= 2) break; // program + subcommand is enough
  }
  const base = prefix.join(' ') || tokens[0] || value;
  return `${tool}(${base} *)`;
}

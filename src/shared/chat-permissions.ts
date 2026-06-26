// Permission model shared between the main process (enforcement) and the
// renderer (rendering the tool-call card + sending decisions).
//
// Rules are strings of the form `Tool(pattern)` — e.g. `Bash(npm run *)`,
// `Bash(git *)`. A bare `Tool` (no parens) is shorthand for `Tool(*)`.
// `*` is the only wildcard. Evaluation order is deny → ask → allow, first
// match wins, and deny beats allow at any scope (see rule-evaluator.ts).

/** The three rule buckets, evaluated deny → ask → allow. */
export type PermissionRules = {
  allow: string[];
  ask: string[];
  deny: string[];
};

/** A deterministic verdict produced by the rule evaluator. */
export type PermissionVerdict = 'allow' | 'ask' | 'deny';

/**
 * Credential / blast-radius paths and commands that must never be silently
 * allowed. Seeded into the deny bucket by default; the user can see them but
 * the UI discourages removal. Kept conservative in Phase 0 — Phase 2 (#291)
 * adds path-scoped fs deny-rules and the sandbox.
 */
export const DEFAULT_DENY_RULES: string[] = [
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~*)',
  'Bash(:(){*)' // fork bomb
];

export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  allow: [],
  ask: [],
  deny: [...DEFAULT_DENY_RULES]
};

/** What the user chose on a tool-call card. */
export type PermissionOutcome = 'allow-once' | 'allow-always' | 'deny';

/** Emitted from main → renderer when a gated tool call needs a decision. */
export type PermissionRequestPayload = {
  requestId: string;
  /** Stream the request belongs to, so the card renders inline in the right convo. */
  streamId: string;
  tool: string;
  /** The exact command (for Bash) or a human-readable description of the call. */
  command: string;
  cwd?: string;
  /**
   * The prefix an "Allow & remember" click would persist as a permanent allow
   * rule, e.g. `npm run` for `npm run build`. Undefined when no safe prefix
   * can be derived.
   */
  rememberPrefix?: string;
  /** A +/- diff preview, shown for file-mutating tools (write_file / edit_file). */
  diff?: string;
};

/** Sent renderer → main when the user clicks an approval button. */
export type PermissionDecisionPayload = {
  requestId: string;
  outcome: PermissionOutcome;
};

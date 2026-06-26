// Agent Skills for Chat. We adopt the open `SKILL.md` standard verbatim:
// a folder containing a `SKILL.md` with YAML frontmatter (`name`,
// `description`, optional `allowed-tools`) plus any bundled scripts/files.
// Progressive disclosure: only name+description are injected up front; the
// body loads on demand via the `load_skill` tool or an explicit `/name`.

/**
 * Per-skill participation, cycled in settings (never mutates the SKILL.md):
 * - `on`        — listed in the system prompt (auto-triggerable), in the `/`
 *                 menu, and loadable.
 * - `name-only` — in the `/` menu and loadable, but kept out of the always-on
 *                 system-prompt listing (saves context; surfaces only when the
 *                 user explicitly invokes it). This is the context-budget lever.
 * - `off`       — hidden everywhere and not loadable.
 */
export type SkillState = 'on' | 'name-only' | 'off';

export type SkillScope = 'personal' | 'project' | 'bundled';

/** Overlay of state overrides keyed by skill name; absent ⇒ default (`on`). */
export type SkillsOverlay = Record<string, SkillState>;

/** Settings-facing summary of one discovered skill. */
export type SkillSummary = {
  name: string;
  description: string;
  scope: SkillScope;
  state: SkillState;
  /** Absolute path to the skill folder (for reveal/audit). */
  dir: string;
  /** Bundled skills are trusted; personal/project come from outside the app. */
  trusted: boolean;
  /** Estimated tokens the name+description add to the system prompt. */
  descTokens: number;
  /** Non-`SKILL.md` files in the folder (scripts/assets) — the audit surface. */
  files: string[];
};

/** Always-on description budget: tokens consumed by `on` skills vs the cap. */
export type SkillsBudget = { used: number; cap: number };

export const DEFAULT_SKILL_BUDGET_TOKENS = 8000;

/** Items offered in the composer's `/` autocomplete menu. */
export type SkillMenuItem = { name: string; description: string };

/** Settings payload: every discovered skill plus the always-on budget meter. */
export type SkillsView = { skills: SkillSummary[]; budget: SkillsBudget };

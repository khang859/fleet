import { z } from 'zod';

/**
 * Getting a skill onto this machine.
 *
 * Two ways in, and they are the two ways people actually get skills. Most users
 * already have some: `SKILL.md` is a shared format, so a folder written for
 * Claude Code or OpenCode sits on disk working perfectly and Fleet simply cannot
 * see it. Scanning for those is the half that pays for itself immediately.
 * The other half is a git repo, because that is how skills are published -
 * `anthropics/skills` and the community collections are repositories people
 * clone, not packages anybody installs.
 *
 * What is deliberately not here is a marketplace. Claude Code has a real one -
 * a `marketplace.json` catalog, six source types, a version cache, an update
 * flow - and it is a package manager, which is a feature to build when there is
 * evidence somebody wants it rather than on the way to this one.
 *
 * Both ways end in the same place: the folder is *copied* into `~/.fleet/skills`
 * and becomes the user's own. The same bargain the MCP import makes, and for the
 * same reason - a skill you edit here should not change under the other tool's
 * feet, and one you edit there should not silently change what this agent does.
 */

/** Which tool's folder a skill was found in. */
export type SkillFoundIn = 'fleet' | 'claude-code' | 'opencode' | 'agents' | 'git';

export type SkillOrigin = {
  foundIn: SkillFoundIn;
  /** Whether the root follows the user everywhere or belongs to this project. */
  scope: 'user' | 'project';
  /** The skills root it was found under. What the dialog groups by. */
  root: string;
  /** The skill's own folder: what installing copies. */
  path: string;
  /** For a clone, the repository it came from. Empty otherwise. */
  from: string;
};

/**
 * How an offered skill relates to what Fleet already has.
 *
 * `changed` says the copy in `~/.fleet/skills` differs from this one, and
 * deliberately does not say which moved. Fleet's copy is meant to drift - that
 * is the point of copying rather than linking - so a user who edited theirs and
 * an upstream that shipped a new version produce the same honest answer: these
 * two are not the same, look before you overwrite.
 */
export type SkillStatus = 'new' | 'known' | 'changed';

export type FoundSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  status: SkillStatus;
};

/** A clone that has been made and not yet installed from or discarded. */
export type SkillFetchResult = {
  /** Identifies the checkout for the install call that follows. */
  fetchId: string;
  /** What was cloned, as the user typed it. */
  from: string;
  /**
   * Where the checkout is.
   *
   * Only so the dialog can say where inside the repository a skill sits. The
   * temp path itself means nothing to anyone - `skills/` does.
   */
  dir: string;
  found: FoundSkill[];
};

/** One skill Fleet holds in `~/.fleet/skills`, as the settings list shows it. */
export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
};

/**
 * What one install run did.
 *
 * Named failures rather than a count, and the run does not stop at the first
 * one. A user who ticked six and can have five wants the five, plus a line
 * saying which one did not come and why.
 */
export type SkillInstallOutcome = {
  installed: string[];
  failed: Array<{ name: string; reason: string }>;
};

/** One skill the user ticked. The path is checked against a known root in main. */
export const SkillPick = z.object({
  name: z.string(),
  path: z.string()
});

export type SkillPickFields = z.infer<typeof SkillPick>;

/**
 * What a repository reference may look like.
 *
 * `owner/repo` shorthand, an https URL, or an ssh one - the three forms every
 * tool in this space accepts, so the one a user has copied from a README works
 * without them having to work out which.
 *
 * Checked here rather than left to `git` because the string becomes an argument
 * to a subprocess. Nothing in it may start with a dash, or `git clone` reads it
 * as a flag rather than a repository.
 */
const SHORTHAND = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const HTTPS = /^https:\/\/[A-Za-z0-9][\w.-]*(:\d+)?\/[\w./~-]+$/;
const SSH = /^git@[A-Za-z0-9][\w.-]*:[\w./~-]+$/;

/** The clone URL for what the user typed, or `null` if it is not one. */
export function toCloneUrl(input: string): string | null {
  const text = input.trim();
  if (text === '' || text.startsWith('-')) return null;
  if (SHORTHAND.test(text)) return `https://github.com/${text}.git`;
  if (HTTPS.test(text) || SSH.test(text)) return text;
  return null;
}

import { z } from 'zod';
import { SUBAGENT_TOOL_NAMES, type SubagentToolName } from './agent-tools';

/**
 * Subagents: work the agent hands to a second agent and reads the answer to.
 *
 * The point is not speed, it is context. A question like "where does auth
 * happen in this repo" costs twenty file reads to answer and one paragraph to
 * state, and the nineteen reads the parent never needed are nineteen it now has
 * to carry for the rest of the conversation. A subagent spends that context in a
 * window of its own and hands back the paragraph.
 *
 * Which is also why a subagent is a poor way to write code. Two of them editing
 * one project make decisions the other cannot see, and the parent gets two
 * reports that each look right and do not fit together. The tools a definition
 * hands out are the honest place to say so, which is why the ones that ship read
 * and do not write.
 *
 * This file is the definitions - what a subagent *is*. What a dispatched one
 * looks like while it runs lives on the tool call that started it, in
 * `agent-tools`, next to the other payloads a call carries beyond its text.
 */

/**
 * How many subagents may run at once, across the whole app.
 *
 * App-wide rather than per pane, because what the cap protects is not any one
 * conversation: it is the rate limit on the account and the money going out per
 * minute, and both of those belong to the machine. Five panes each running five
 * children would be twenty-five calls in flight against a limit that has never
 * heard of panes.
 */
export const MAX_PARALLEL_TASKS = 5;

/** Where a definition was found. Decides precedence, and is shown in the UI. */
export type SubagentSource = 'project' | 'user' | 'bundled';

/** A subagent definition, as one `.md` file describes it. */
export type SubagentDefinition = {
  name: string;
  /**
   * When to reach for this one, addressed to the parent model.
   *
   * The only text the parent ever sees about a candidate, which makes it the
   * routing algorithm rather than documentation. A description saying what the
   * subagent *is* instead of when to use it produces a subagent that never gets
   * used, and that is the first thing to check when one doesn't.
   */
  description: string;
  /** `inherit` (the default) means whatever the parent is running. */
  model: string;
  /** The tools this one gets when a call names none. `null` ⇒ all of them. */
  tools: SubagentToolName[] | null;
  /** The body below the frontmatter: the child's system prompt. */
  systemPrompt: string;
  source: SubagentSource;
  path: string;
};

/**
 * Frontmatter as a file writes it.
 *
 * `name` is constrained because it is what the model types to choose this
 * subagent. A name with a space or a capital in it is one the model will get
 * subtly wrong and then be told does not exist, and the file it came from will
 * look fine.
 */
export const SubagentFrontmatter = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  description: z.string().min(1),
  model: z.string().default('inherit'),
  tools: z.array(z.enum(SUBAGENT_TOOL_NAMES)).optional()
});

/**
 * Which model a dispatch runs on: what the definition says, or what the parent
 * is running.
 *
 * `inherit` is spelled out rather than left as an absent field, so a definition
 * can say "whatever is driving this conversation" and mean it - a definition
 * pinned to a model the user has since stopped paying for is worse than one that
 * follows along.
 *
 * The caller does not get a say. It is the one thing about a dispatch the
 * parent model has no way to be right about - it cannot see the catalog, the
 * user's keys, or what anything costs - and a `model` field beside an `agent`
 * field is answered with the agent's name, which is what happened the first two
 * times this ran.
 */
export function resolveTaskModel(definitionModel: string, parentModel: string): string {
  return definitionModel === 'inherit' ? parentModel : definitionModel;
}

/**
 * The tools one dispatch hands over.
 *
 * The caller's list replaces the definition's rather than narrowing it, because
 * the parent is the one that knows what this particular errand needs - a
 * reviewer that usually only reads may genuinely have to run the tests this
 * time, and a definition written last month cannot have known that.
 *
 * Nothing is given away by allowing it. What keeps a subagent honest is not the
 * list of tools it holds but the permission gate, and every command a child runs
 * goes through the same gate, the same rules, and the same always-ask list as
 * one the user watched the parent run.
 */
export function resolveTaskTools(
  definitionTools: SubagentToolName[] | null,
  callTools: SubagentToolName[] | null
): SubagentToolName[] {
  return callTools ?? definitionTools ?? [...SUBAGENT_TOOL_NAMES];
}

import type { ServerToolSpec } from './agent-server-tools';
import type { ToolSpec } from './agent-tools';

/**
 * Deferred tool discovery: withholding the tools a turn probably will not use,
 * and giving the model a way to ask for them.
 *
 * The problem is arithmetic rather than design. Every tool definition is
 * restated on every request of every round, so a turn of eight rounds pays for
 * the whole list eight times - and the list grows with each MCP server the
 * user connects rather than with anything they asked for. Measured on a
 * machine with three servers connected, the definitions came to 11,528
 * estimated tokens per request, of which the seven MCP tools were 3,817. A
 * user with a dozen servers is spending five figures of input tokens per round
 * describing tools the turn will never touch.
 *
 * Accuracy is the other half, and it is the half that is harder to see: a
 * model choosing between several hundred near-identical tool names picks wrong
 * more often than one choosing between twenty.
 *
 * `openrouter:tool_search` addresses both. A tool marked `defer_loading` is
 * described to the model only after it searches for one - the search runs a
 * regular expression over names, descriptions, argument names and argument
 * descriptions on OpenRouter's side, and the matches are loaded for the rest
 * of the request.
 *
 * Two hard constraints come with it, and both are 400s rather than
 * degradations:
 *
 * - The tool is rejected on Chat Completions. It needs the Responses API,
 *   which is why `responses.ts` exists at all.
 * - With deferral active, `tool_choice` must be omitted or `allowed_tools`.
 *   Fleet has never sent `tool_choice`, so this costs nothing today and is
 *   written down here so it stays true.
 */

/** The tool as the request states it. Never itself deferred - that is a 400. */
export const TOOL_SEARCH_TOOL_NAME = 'openrouter:tool_search';

/**
 * How many tools one search may load, and the reason the ceiling is low.
 *
 * OpenRouter's own default is 5 and it caps at 50. A search that returned
 * fifty definitions would have undone the saving inside a single round, so
 * this stays near the default: the model can search again, and a second
 * search costs a fraction of what carrying fifty unused definitions costs.
 */
export const TOOL_SEARCH_MIN_RESULTS = 1;
export const TOOL_SEARCH_MAX_RESULTS = 25;

export type AgentToolSearchConfig = {
  /**
   * Off by default, and deliberately so.
   *
   * Deferral trades a round for tokens: the first turn that needs an MCP tool
   * spends one extra step finding it. That is the right trade for somebody
   * with a dozen servers connected and the wrong one for somebody with none,
   * and Fleet cannot tell which it is looking at without asking.
   */
  enabled: boolean;
  /** Tools one search may load. */
  maxResults: number;
};

export const DEFAULT_AGENT_TOOL_SEARCH: AgentToolSearchConfig = {
  enabled: false,
  maxResults: 5
};

/**
 * The tool search entry for a request, or nothing when deferral is off.
 *
 * `max_results` is always sent rather than left to OpenRouter's default,
 * because the number is a setting the user can see and a default that drifted
 * would make their setting a lie.
 */
export function toolSearchSpec(config: AgentToolSearchConfig): ServerToolSpec | null {
  if (!config.enabled) return null;
  return {
    type: TOOL_SEARCH_TOOL_NAME,
    parameters: { max_results: config.maxResults }
  };
}

/**
 * The tool list split into what is stated up front and what is withheld.
 *
 * The line is drawn at ownership rather than at a hand-kept list of names, and
 * that is the whole policy. Fleet's own twenty tools are the ones every turn
 * uses - reading a file, running a command, searching the tree - and a turn
 * that had to search before it could read would be worse in every way that
 * matters. They are also fixed: they do not grow when the user installs
 * something, so they are not what the arithmetic is about.
 *
 * MCP tools are the opposite on both counts. They are unbounded, they are the
 * user's own additions, and most turns touch none of them. So they defer.
 *
 * A name-based list of "common" tools was the alternative and is worse: it
 * would need updating every time a tool is added, and being wrong about it is
 * silent - the model simply gets slower and nobody knows why.
 *
 * Returns everything as loaded when deferral is off, so the caller has one
 * shape to handle rather than a branch.
 */
export function splitDeferred(
  mcp: ToolSpec[],
  enabled: boolean
): { loaded: ToolSpec[]; deferred: ToolSpec[] } {
  if (!enabled) return { loaded: mcp, deferred: [] };
  return { loaded: [], deferred: mcp };
}

/**
 * What the model is told about a tool list it cannot see all of.
 *
 * Without this the deferred half is invisible: the model reads the twenty
 * tools it was given, concludes there is no way to reach the user's issue
 * tracker, and says so. The block exists to turn "there is no tool for that"
 * into "there may be a tool for that, search first".
 *
 * Only assembled when deferral is actually on. See `buildSystemPrompt`.
 */
export const AGENT_TOOL_SEARCH_INSTRUCTIONS = [
  '## Tools you have not been shown',
  '',
  `The tools listed for you are not all of them. Tools from the user's connected servers are held back until you ask for them, with \`${TOOL_SEARCH_TOOL_NAME}\`.`,
  '',
  'Search before you conclude that something cannot be done. If the task mentions a service, a product or a system that is not one of your listed tools - an issue tracker, a design library, a documentation host, a database - assume a tool for it may exist and search for it.',
  '',
  'The search takes a regular expression and matches it against tool names, descriptions, argument names and argument descriptions. Search for the subject rather than for a guessed tool name: `issue|ticket` finds more than `create_issue` does.',
  '',
  'A tool you find this way is used exactly like one you were given. Nothing else changes: it still runs on this machine, and it still asks the user before doing anything that needs asking.'
].join('\n');

import type { AgentToolContext, AgentToolResult, WebFetchArgs } from '../../../shared/agent-tools';
import type { z } from 'zod';

/**
 * Read a web page.
 *
 * Thin on purpose. Everything that decides whether this URL may be reached, and
 * everything that turns the page into markdown, lives behind `ctx.fetchUrl` -
 * so what is left here is the shape every other tool has: check what the model
 * wrote, run the thing, and say in one line what came back.
 */

/** The `web_fetch` schema's own type, kept local so callers pass a checked value. */
type Args = z.infer<typeof WebFetchArgs>;

export async function runWebFetch(args: Args, ctx: AgentToolContext): Promise<AgentToolResult> {
  if (ctx.fetchUrl === null) {
    throw new Error(
      "Reading web pages is off - it is a switch in Fleet's agent settings. Tell the user that is where to turn it on, and do not try to fetch the page another way."
    );
  }

  const text = await ctx.fetchUrl(args.url, ctx.signal);
  return { text, summary: summarize(text) };
}

/**
 * The one line the row shows.
 *
 * Words rather than characters: what a person wants to know from a collapsed
 * row is roughly how much of the page came back, and nobody has an instinct for
 * what forty thousand characters looks like.
 */
function summarize(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 'nothing';
  if (words < 1000) return `${words} words`;
  return `${(words / 1000).toFixed(1).replace(/\.0$/, '')}k words`;
}

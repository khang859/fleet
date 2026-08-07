import type { AgentTurnUsage, AgentUsage } from './agent-types';

/**
 * What a session has spent, and the arithmetic that gets there.
 *
 * Pure, and in `shared`, for the reason the context accounting next door is:
 * the numbers are assembled in three places - a turn's rounds in main, a
 * session's turns in the renderer, a listing's read off disk - and the only way
 * they agree is if none of them does the adding itself.
 *
 * Money is the point of it. A token count that is slightly wrong is a slightly
 * wrong gauge; a cost that is wrong is a number the user will compare against
 * their OpenRouter invoice, and lose confidence in everything else on the
 * screen when it does not match.
 */

/**
 * The running total for one session: every model call it has made, added up.
 *
 * `costUsd` is `null` rather than `0` for a session nothing has ever reported a
 * cost for - a free model, a provider that does not price its responses, or a
 * session that predates any of this. Zero is a real answer and this is not one,
 * and the meter shows nothing at all rather than an authoritative `$0.00`.
 */
export type AgentSessionSpend = {
  costUsd: number | null;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Billed calls, so the total can be read as a rate rather than a lump. */
  calls: number;
};

export const EMPTY_SESSION_SPEND: AgentSessionSpend = {
  costUsd: null,
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  calls: 0
};

/**
 * Two costs added, keeping `null` distinct from zero.
 *
 * `null` means nobody said, so it disappears the moment anybody does: a session
 * whose first turn was priced and whose second was not has a cost, and it is
 * the part we know about. Only a total nothing has ever priced stays unknown.
 */
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

/**
 * A whole turn folded into a session's total.
 *
 * The turn arrives already summed over its own rounds, so this only has to add
 * one set of numbers to another - and takes the call count from the turn rather
 * than counting one per turn, because a turn is however many calls it took.
 */
export function addTurn(total: AgentSessionSpend, turn: AgentTurnUsage): AgentSessionSpend {
  const { billed } = turn;
  return {
    costUsd: addCost(total.costUsd, billed.costUsd),
    promptTokens: total.promptTokens + billed.promptTokens,
    cachedTokens: total.cachedTokens + billed.cachedTokens,
    cacheWriteTokens: total.cacheWriteTokens + billed.cacheWriteTokens,
    completionTokens: total.completionTokens + billed.completionTokens,
    reasoningTokens: total.reasoningTokens + billed.reasoningTokens,
    calls: total.calls + turn.calls
  };
}

/** One round's usage folded into the turn being built. */
export function addRound(billed: AgentUsage, round: AgentUsage): AgentUsage {
  return {
    promptTokens: billed.promptTokens + round.promptTokens,
    completionTokens: billed.completionTokens + round.completionTokens,
    totalTokens: billed.totalTokens + round.totalTokens,
    cachedTokens: billed.cachedTokens + round.cachedTokens,
    cacheWriteTokens: billed.cacheWriteTokens + round.cacheWriteTokens,
    reasoningTokens: billed.reasoningTokens + round.reasoningTokens,
    costUsd: addCost(billed.costUsd, round.costUsd)
  };
}

/**
 * Whether a total has anything to show.
 *
 * A session that ran a turn the provider priced at nothing still has tokens to
 * account for, so the test is "did anything happen" rather than "did it cost
 * money" - otherwise a free model's session shows a blank where its token
 * counts should be.
 */
export function hasSpend(total: AgentSessionSpend): boolean {
  return total.calls > 0 || total.promptTokens > 0 || total.completionTokens > 0;
}

/**
 * Input tokens that were charged at the full rate: the part of the prompt the
 * cache did not cover.
 *
 * The number worth showing, and not the one the API reports. OpenRouter says
 * how much was cached; what a person paying for it wants to know is how much
 * was not, and the difference between those two framings is the difference
 * between a statistic and a reason.
 */
export function billedInput(
  total: Pick<AgentSessionSpend, 'promptTokens' | 'cachedTokens'>
): number {
  return Math.max(0, total.promptTokens - total.cachedTokens);
}

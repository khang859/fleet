import { describe, it, expect } from 'vitest';
import { EMPTY_AGENT_USAGE, type AgentTurnUsage, type AgentUsage } from '../agent-types';
import {
  EMPTY_SESSION_SPEND,
  addRound,
  addTurn,
  billedInput,
  hasSpend,
  type AgentSessionSpend
} from '../agent-spend';

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({ ...EMPTY_AGENT_USAGE, ...over });

const turn = (billed: Partial<AgentUsage>, over: Partial<AgentTurnUsage> = {}): AgentTurnUsage => ({
  billed: usage(billed),
  contextTokens: null,
  calls: 1,
  model: null,
  provider: null,
  ...over
});

describe('addRound', () => {
  it('adds every count, so a turn is billed for all its rounds', () => {
    const first = addRound(
      EMPTY_AGENT_USAGE,
      usage({ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, costUsd: 0.01 })
    );
    const second = addRound(
      first,
      usage({ promptTokens: 1200, completionTokens: 80, totalTokens: 1280, costUsd: 0.012 })
    );

    expect(second.promptTokens).toBe(2200);
    expect(second.completionTokens).toBe(130);
    expect(second.totalTokens).toBe(2330);
    expect(second.costUsd).toBeCloseTo(0.022, 10);
  });

  it('carries the detail counts through', () => {
    const total = addRound(
      usage({ cachedTokens: 100, cacheWriteTokens: 10, reasoningTokens: 5 }),
      usage({ cachedTokens: 900, cacheWriteTokens: 0, reasoningTokens: 45 })
    );
    expect(total.cachedTokens).toBe(1000);
    expect(total.cacheWriteTokens).toBe(10);
    expect(total.reasoningTokens).toBe(50);
  });

  it('keeps an unpriced round from erasing a priced one', () => {
    const priced = addRound(EMPTY_AGENT_USAGE, usage({ costUsd: 0.02 }));
    expect(addRound(priced, usage({ costUsd: null })).costUsd).toBe(0.02);
  });

  it('leaves the cost unknown while nothing has reported one', () => {
    expect(addRound(EMPTY_AGENT_USAGE, usage({ costUsd: null })).costUsd).toBeNull();
  });
});

describe('addTurn', () => {
  it('accumulates turns into a session total', () => {
    const first = addTurn(
      EMPTY_SESSION_SPEND,
      turn({ promptTokens: 1000, completionTokens: 100, costUsd: 0.03 }, { calls: 3 })
    );
    const second = addTurn(
      first,
      turn({ promptTokens: 500, completionTokens: 40, costUsd: 0.01 }, { calls: 1 })
    );

    expect(second).toEqual<AgentSessionSpend>({
      costUsd: 0.04,
      promptTokens: 1500,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 140,
      reasoningTokens: 0,
      calls: 4
    });
  });

  it('counts the calls the turn made, not one per turn', () => {
    expect(addTurn(EMPTY_SESSION_SPEND, turn({}, { calls: 17 })).calls).toBe(17);
  });

  it('ignores the context figure, which is not a thing to add up', () => {
    const total = addTurn(
      EMPTY_SESSION_SPEND,
      turn({ promptTokens: 10 }, { contextTokens: 90_000 })
    );
    expect(total.promptTokens).toBe(10);
  });

  it('starts counting from the first turn anyone priced', () => {
    const free = addTurn(EMPTY_SESSION_SPEND, turn({ promptTokens: 10 }));
    expect(free.costUsd).toBeNull();
    expect(addTurn(free, turn({ costUsd: 0.05 })).costUsd).toBe(0.05);
  });
});

describe('billedInput', () => {
  it('is the part of the prompt the cache did not cover', () => {
    expect(billedInput({ promptTokens: 124_000, cachedTokens: 98_000 })).toBe(26_000);
  });

  it('never goes negative on a provider that counts them separately', () => {
    expect(billedInput({ promptTokens: 100, cachedTokens: 400 })).toBe(0);
  });
});

describe('hasSpend', () => {
  it('is false for a session that has never run a turn', () => {
    expect(hasSpend(EMPTY_SESSION_SPEND)).toBe(false);
  });

  it('is true for a free model, which spends tokens and no money', () => {
    expect(hasSpend(addTurn(EMPTY_SESSION_SPEND, turn({ promptTokens: 900 })))).toBe(true);
  });
});

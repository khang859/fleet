import { describe, expect, it } from 'vitest';
import { agentPhase, formatElapsed, phaseShimmers, reasoningLabel } from '../activity';

describe('agentPhase', () => {
  it('waits before the turn has said what it is doing', () => {
    expect(agentPhase(null, false)).toBe('waiting');
  });

  it('shows the step the turn is on', () => {
    expect(agentPhase({ phase: 'drafting', since: 0 }, false)).toBe('drafting');
    expect(agentPhase({ phase: 'checking', since: 0 }, false)).toBe('checking');
  });

  // A compaction streams into no message at all, so no step says it.
  it('reports compacting whatever the step says', () => {
    expect(agentPhase({ phase: 'writing', since: 0 }, true)).toBe('compacting');
    expect(agentPhase(null, true)).toBe('compacting');
  });

  // The question may be a subagent's, which moves no step of this turn.
  it('reports asking over everything else', () => {
    expect(agentPhase({ phase: 'tooling', since: 0 }, true, true)).toBe('asking');
  });
});

describe('phaseShimmers', () => {
  // The rule the indicator is built on: animate the label only when nothing
  // else on screen is moving.
  it('shimmers only while there is no text streaming in', () => {
    expect(phaseShimmers('waiting')).toBe(true);
    expect(phaseShimmers('compacting')).toBe(true);
    expect(phaseShimmers('drafting')).toBe(true);
    expect(phaseShimmers('checking')).toBe(true);
    expect(phaseShimmers('writing')).toBe(false);
    // The tool's own row is shimmering instead.
    expect(phaseShimmers('tooling')).toBe(false);
  });

  // In a later round the reasoning block is folded away above the calls, and
  // the label is the only thing saying the model is thinking.
  it('shimmers on reasoning only when the reasoning is not on screen', () => {
    expect(phaseShimmers('reasoning', true)).toBe(false);
    expect(phaseShimmers('reasoning', false)).toBe(true);
  });
});

describe('formatElapsed', () => {
  it('counts seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('switches to a zero-padded clock at a minute', () => {
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(72_000)).toBe('1:12');
    expect(formatElapsed(605_000)).toBe('10:05');
  });

  // A clock jumping backwards past zero would be a worse lie than showing none.
  it('never goes negative when the clock moves under it', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('reasoningLabel', () => {
  it('names the duration once there is one worth naming', () => {
    expect(reasoningLabel(5_355)).toBe('Thought for 5s');
    expect(reasoningLabel(68_000)).toBe('Thought for 1:08');
  });

  // "Thought for 0s" reads as a broken clock. A reply that came back in half a
  // second still thought - there is just no number worth putting on it.
  it('drops the number when the thinking was under a second', () => {
    expect(reasoningLabel(635)).toBe('Thought');
    expect(reasoningLabel(0)).toBe('Thought');
  });

  it('says only that it thought when nothing was measured', () => {
    expect(reasoningLabel(null)).toBe('Thought');
  });
});

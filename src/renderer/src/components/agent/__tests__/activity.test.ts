import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../../../../shared/agent-types';
import { agentPhase, formatElapsed, phaseShimmers, reasoningLabel } from '../activity';

function message(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoningMs: null,
    toolCalls: [],
    ...over
  };
}

describe('agentPhase', () => {
  it('waits while the placeholder is empty in both channels', () => {
    expect(agentPhase(message(), false)).toBe('waiting');
  });

  it('reports reasoning once thinking tokens arrive but no answer has', () => {
    expect(agentPhase(message({ reasoning: 'Let me check' }), false)).toBe('reasoning');
  });

  it('reports writing as soon as there is answer text, reasoning or not', () => {
    expect(agentPhase(message({ content: 'The' }), false)).toBe('writing');
    expect(agentPhase(message({ content: 'The', reasoning: 'hm' }), false)).toBe('writing');
  });

  // A compaction streams into no message at all, so the transcript still ends
  // with the last completed turn and cannot be read for the phase.
  it('reports compacting regardless of what the transcript ends with', () => {
    expect(agentPhase(message({ content: 'Done.' }), true)).toBe('compacting');
    expect(agentPhase(undefined, true)).toBe('compacting');
  });

  // The model writes "let me look at that" and then calls a tool. What the
  // user is waiting on from that moment is the tool, not the sentence.
  it('reports working while a tool call is still running', () => {
    const running = {
      id: 'c1',
      name: 'read',
      args: '{}',
      result: null,
      error: null,
      summary: null
    };
    expect(agentPhase(message({ content: 'Let me look.', toolCalls: [running] }), false)).toBe(
      'tooling'
    );
  });

  it('goes back to the answer once every call has come back', () => {
    const done = {
      id: 'c1',
      name: 'read',
      args: '{}',
      result: 'x',
      error: null,
      summary: '1 line'
    };
    expect(agentPhase(message({ content: 'It says', toolCalls: [done] }), false)).toBe('writing');
    expect(agentPhase(message({ toolCalls: [done] }), false)).toBe('waiting');
  });

  it('waits on an empty transcript, and when the last word was the user’s', () => {
    expect(agentPhase(undefined, false)).toBe('waiting');
    expect(agentPhase(message({ role: 'user', content: 'hi' }), false)).toBe('waiting');
  });
});

describe('phaseShimmers', () => {
  // The rule the indicator is built on: animate the label only when nothing
  // else on screen is moving.
  it('shimmers only while there is no text streaming in', () => {
    expect(phaseShimmers('waiting')).toBe(true);
    expect(phaseShimmers('compacting')).toBe(true);
    expect(phaseShimmers('reasoning')).toBe(false);
    expect(phaseShimmers('writing')).toBe(false);
    // The tool's own row is shimmering instead.
    expect(phaseShimmers('tooling')).toBe(false);
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

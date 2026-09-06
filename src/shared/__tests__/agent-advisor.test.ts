import { describe, expect, it } from 'vitest';
import {
  AGENT_ADVISOR_INSTRUCTIONS,
  DEFAULT_AGENT_ADVISOR,
  advisorSpec,
  parseAdvisorPrompt,
  parseAdvisorResult,
  type AgentAdvisorConfig
} from '../agent-advisor';

const on: AgentAdvisorConfig = {
  ...DEFAULT_AGENT_ADVISOR,
  enabled: true,
  model: 'anthropic/claude-opus-4.8'
};

describe('advisorSpec', () => {
  it('offers nothing when the advisor is off', () => {
    expect(advisorSpec(DEFAULT_AGENT_ADVISOR)).toBeNull();
  });

  /*
   * OpenRouter's precedence lets the executing model name its own advisor, and
   * falls back to the executor itself when nobody names one. A consultation
   * where the model asks itself is a second bill for the first opinion, so an
   * unset model disables the tool rather than sending it open.
   */
  it('offers nothing when no advisor model has been chosen', () => {
    expect(advisorSpec({ ...on, model: null })).toBeNull();
  });

  it('pins the model, the budget, and the question-only mode', () => {
    expect(advisorSpec(on)).toEqual({
      type: 'openrouter:advisor',
      parameters: {
        model: 'anthropic/claude-opus-4.8',
        forward_transcript: false,
        max_completion_tokens: DEFAULT_AGENT_ADVISOR.maxTokens
      }
    });
  });

  // Forwarding the transcript turns a question into a re-read of the whole
  // conversation at the dearer model's price.
  it('never forwards the transcript', () => {
    expect(advisorSpec(on)?.parameters?.forward_transcript).toBe(false);
  });

  it('sends instructions only when there are some', () => {
    expect(advisorSpec({ ...on, instructions: '   ' })?.parameters).not.toHaveProperty(
      'instructions'
    );
    expect(advisorSpec({ ...on, instructions: '  Be decisive.  ' })?.parameters).toMatchObject({
      instructions: 'Be decisive.'
    });
  });

  // One unnamed entry is the default advisor. A name would make it a second
  // tool in the model's list for no gain until there are two of them.
  it('leaves the advisor unnamed', () => {
    expect(advisorSpec(on)?.parameters).not.toHaveProperty('name');
  });
});

describe('parseAdvisorResult', () => {
  it('reads advice and the model that gave it', () => {
    expect(
      parseAdvisorResult(
        '{"status":"ok","model":"anthropic/claude-opus-4.8","advice":"Use a channel."}'
      )
    ).toEqual({ status: 'ok', model: 'anthropic/claude-opus-4.8', advice: 'Use a channel.' });
  });

  /*
   * A consultation that failed is a turn that got no second opinion, not a turn
   * that failed - so this is an ordinary result to render, never an exception.
   */
  it('reads a failure as a result rather than as a fault', () => {
    expect(parseAdvisorResult('{"status":"error","error":"Advisor call failed: 429"}')).toEqual({
      status: 'error',
      error: 'Advisor call failed: 429'
    });
  });

  it('describes a failure that did not say why', () => {
    expect(parseAdvisorResult('{"status":"error"}')).toEqual({
      status: 'error',
      error: 'The advisor did not answer.'
    });
  });

  it('gives up on a payload it does not recognise, so the row shows the raw text', () => {
    expect(parseAdvisorResult('not json')).toBeNull();
    expect(parseAdvisorResult('{"status":"ok"}')).toBeNull();
    expect(parseAdvisorResult('[]')).toBeNull();
  });
});

describe('parseAdvisorPrompt', () => {
  it('finds the question that was asked', () => {
    expect(parseAdvisorPrompt('{"prompt":"Which schema survives a rename?"}')).toBe(
      'Which schema survives a rename?'
    );
  });

  it('has no question when the arguments carry none', () => {
    expect(parseAdvisorPrompt('{"model":"x"}')).toBeNull();
    expect(parseAdvisorPrompt('{"prompt":""}')).toBeNull();
    expect(parseAdvisorPrompt('nonsense')).toBeNull();
  });
});

describe('defaults', () => {
  // It spends money on a second, dearer model. Nobody should discover that
  // from an invoice.
  it('ships off, and with no model chosen', () => {
    expect(DEFAULT_AGENT_ADVISOR.enabled).toBe(false);
    expect(DEFAULT_AGENT_ADVISOR.model).toBeNull();
  });
});

describe('AGENT_ADVISOR_INSTRUCTIONS', () => {
  // The failure the block exists to prevent: a question written as though the
  // advisor could see the code the executor has been reading.
  it('says the advisor sees only the question', () => {
    expect(AGENT_ADVISOR_INSTRUCTIONS).toContain('sees only');
    expect(AGENT_ADVISOR_INSTRUCTIONS).toContain('cannot read this folder');
  });
});

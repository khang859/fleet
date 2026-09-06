import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_FUSION,
  FUSION_MAX_PANEL,
  FUSION_TOOL_NAME,
  fusionFailureMessage,
  fusionSpec,
  parseFusionResult
} from '../agent-fusion';

describe('fusionSpec', () => {
  it('omits the panel when none is chosen, so OpenRouter picks it', () => {
    const spec = fusionSpec(DEFAULT_AGENT_FUSION);
    expect(spec.type).toBe(FUSION_TOOL_NAME);
    expect(spec.parameters).not.toHaveProperty('analysis_models');
    expect(spec.parameters).not.toHaveProperty('model');
    expect(spec.parameters?.max_completion_tokens).toBe(16_000);
    expect(spec.parameters?.max_tool_calls).toBe(4);
  });

  it('sends the panel and the analyst when both are set', () => {
    const spec = fusionSpec({
      ...DEFAULT_AGENT_FUSION,
      models: ['a/one', 'b/two'],
      analyst: 'c/three'
    });
    expect(spec.parameters?.analysis_models).toEqual(['a/one', 'b/two']);
    expect(spec.parameters?.model).toBe('c/three');
  });

  it('truncates a panel that has grown past the limit rather than failing the request', () => {
    const models = Array.from({ length: 12 }, (_, i) => `m/${i}`);
    const spec = fusionSpec({ ...DEFAULT_AGENT_FUSION, models });
    expect(spec.parameters?.analysis_models).toHaveLength(FUSION_MAX_PANEL);
  });
});

describe('parseFusionResult', () => {
  it('is null for a payload that is not a fusion result', () => {
    expect(parseFusionResult('not json')).toBeNull();
    expect(parseFusionResult('{"foo":1}')).toBeNull();
  });

  it('reads a full analysis, renaming the wire keys', () => {
    const result = parseFusionResult(
      JSON.stringify({
        status: 'ok',
        analysis: {
          consensus: ['the change is sound'],
          contradictions: [
            { topic: 'retries', stances: [{ model: 'a/one', stance: 'needs a cap' }] }
          ],
          partial_coverage: [{ models: ['a/one'], point: 'no test for the empty case' }],
          unique_insights: [{ model: 'b/two', insight: 'the lock is held too long' }],
          blind_spots: ['nobody read the migration']
        },
        responses: [{ model: 'a/one', content: 'looks fine' }]
      })
    );
    expect(result?.status).toBe('ok');
    if (result?.status !== 'ok' || result.analysis === null) throw new Error('expected analysis');
    expect(result.analysis.consensus).toEqual(['the change is sound']);
    expect(result.analysis.contradictions[0].stances[0].model).toBe('a/one');
    expect(result.analysis.partialCoverage[0].models).toEqual(['a/one']);
    expect(result.analysis.uniqueInsights[0].insight).toBe('the lock is held too long');
    expect(result.analysis.blindSpots).toEqual(['nobody read the migration']);
    expect(result.responses).toHaveLength(1);
  });

  it('fills every missing section, so a renderer never checks for absence', () => {
    const result = parseFusionResult(
      JSON.stringify({ status: 'ok', analysis: { consensus: ['one'] } })
    );
    if (result?.status !== 'ok' || result.analysis === null) throw new Error('expected analysis');
    expect(result.analysis.contradictions).toEqual([]);
    expect(result.analysis.partialCoverage).toEqual([]);
    expect(result.analysis.uniqueInsights).toEqual([]);
    expect(result.analysis.blindSpots).toEqual([]);
    expect(result.responses).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('keeps the replies when the analyst failed and the panel did not', () => {
    const result = parseFusionResult(
      JSON.stringify({
        status: 'ok',
        responses: [
          { model: 'a/one', content: 'looks fine' },
          { model: 'b/two', content: 'the retry loop is unbounded' }
        ]
      })
    );
    if (result?.status !== 'ok') throw new Error('expected ok');
    expect(result.analysis).toBeNull();
    expect(result.responses).toHaveLength(2);
  });

  it('treats an analysis with nothing in it as no analysis', () => {
    const result = parseFusionResult(
      JSON.stringify({ status: 'ok', analysis: { consensus: [], blind_spots: [] } })
    );
    if (result?.status !== 'ok') throw new Error('expected ok');
    expect(result.analysis).toBeNull();
  });

  it('reports the models that dropped out alongside the ones that answered', () => {
    const result = parseFusionResult(
      JSON.stringify({
        status: 'ok',
        responses: [{ model: 'a/one', content: 'fine' }],
        failed_models: [{ model: 'b/two', reason: 'timeout' }, { model: 'c/three' }]
      })
    );
    if (result?.status !== 'ok') throw new Error('expected ok');
    expect(result.failed).toEqual([
      { model: 'b/two', reason: 'timeout' },
      { model: 'c/three', reason: null }
    ]);
  });

  it('reads an error result with its documented reason', () => {
    const result = parseFusionResult(
      JSON.stringify({
        status: 'error',
        error: 'no credit',
        failure_reason: 'insufficient_credits'
      })
    );
    if (result?.status !== 'error') throw new Error('expected error');
    expect(result.failureReason).toBe('insufficient_credits');
    expect(result.error).toBe('no credit');
  });

  it('keeps a failure reason this build has never heard of', () => {
    const result = parseFusionResult(
      JSON.stringify({ status: 'error', failure_reason: 'panel_on_fire' })
    );
    if (result?.status !== 'error') throw new Error('expected error');
    expect(result.failureReason).toBe('panel_on_fire');
    expect(fusionFailureMessage(result.failureReason)).toBe('panel_on_fire');
  });
});

describe('fusionFailureMessage', () => {
  it('says what to do about each documented reason', () => {
    for (const reason of [
      'all_panels_failed',
      'insufficient_credits',
      'rate_limited',
      'fusion_invocation_capped',
      'unexpected_error'
    ]) {
      const message = fusionFailureMessage(reason);
      expect(message).not.toBe(reason);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('has something to say when no reason was given', () => {
    expect(fusionFailureMessage(null)).toContain('did not complete');
  });
});

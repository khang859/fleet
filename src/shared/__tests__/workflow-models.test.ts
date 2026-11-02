import { describe, expect, it } from 'vitest';
import {
  effectiveChoices,
  modelChoiceProblem,
  modelChoiceText,
  parsePiModels,
  switchProgram
} from '../workflow-models';
import type { WorkflowStageDef } from '../workflows';

describe('modelChoiceProblem', () => {
  it('takes the program defaults, an alias, a full ID and a provider model', () => {
    expect(modelChoiceProblem('claude', {})).toBeNull();
    expect(modelChoiceProblem('claude', { model: 'opus', effort: 'max' })).toBeNull();
    expect(modelChoiceProblem('claude', { model: 'claude-opus-5-5[1m]' })).toBeNull();
    expect(modelChoiceProblem('pi', { model: 'openai/gpt-5:high', effort: 'off' })).toBeNull();
  });

  it('refuses a model that could be read as a flag or split a command line', () => {
    expect(modelChoiceProblem('claude', { model: '--dangerously-skip-permissions' })).toMatch(
      /not a model name/
    );
    expect(modelChoiceProblem('pi', { model: 'a b' })).toMatch(/not a model name/);
    expect(modelChoiceProblem('pi', { model: '' })).toMatch(/not a model name/);
  });

  it('refuses a level the program does not have', () => {
    expect(modelChoiceProblem('claude', { effort: 'off' })).toBe(
      'effort must be one of low, medium, high, xhigh, max.'
    );
    expect(modelChoiceProblem('pi', { effort: 'huge' })).toMatch(/effort must be one of off/);
  });
});

describe('switchProgram', () => {
  it('keeps everything when the program stays', () => {
    const agent = { program: 'claude' as const, model: 'opus', effort: 'high' };
    expect(switchProgram(agent, 'claude')).toBe(agent);
  });

  it('drops the model, and a level the other program lacks', () => {
    expect(switchProgram({ program: 'claude', model: 'opus', effort: 'high' }, 'pi')).toEqual({
      program: 'pi',
      model: undefined,
      effort: 'high'
    });
    expect(switchProgram({ program: 'pi', effort: 'minimal' }, 'claude')).toEqual({
      program: 'claude',
      model: undefined,
      effort: undefined
    });
  });
});

describe('effectiveChoices', () => {
  const agent = (role: string, extra: object = {}) => ({
    role,
    program: 'claude' as const,
    prompt: 'p',
    ...extra
  });

  it('gives a resume agent the choice of its latest earlier agent, unless it sets its own', () => {
    const stages: WorkflowStageDef[] = [
      { name: 'One', agents: [agent('lead', { model: 'opus', effort: 'high' }), agent('aid')] },
      { name: 'Two', agents: [agent('lead', { resume: 'lead', effort: 'low' })] },
      { name: 'Three', agents: [agent('next', { resume: 'lead' }), agent('new')] }
    ];

    expect(effectiveChoices(stages)).toEqual([
      [{ model: 'opus', effort: 'high' }, {}],
      [{ model: 'opus', effort: 'low' }],
      [{ model: 'opus', effort: 'low' }, {}]
    ]);
  });
});

describe('modelChoiceText', () => {
  it('joins what is set', () => {
    expect(modelChoiceText({})).toBe('');
    expect(modelChoiceText({ effort: 'high' })).toBe('high');
    expect(modelChoiceText({ model: 'opus', effort: 'high' })).toBe('opus · high');
  });
});

describe('parsePiModels', () => {
  it('reads provider and model from each row under the header', () => {
    const text = [
      'provider     model                context  max-out  thinking  images',
      'local-llama  qwen3.6-abliterated  262.1K   32.8K    yes       yes   ',
      'openai       gpt-5                400K     128K     yes       yes',
      ''
    ].join('\n');

    expect(parsePiModels(text)).toEqual(['local-llama/qwen3.6-abliterated', 'openai/gpt-5']);
  });

  it('gives nothing for a message with no table', () => {
    expect(parsePiModels('No models available. Run pi auth login.\n')).toEqual([]);
  });
});

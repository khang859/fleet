import { describe, it, expect } from 'vitest';
import { OUTPUT_SEPARATOR, type AgentToolCall } from '../agent-tools';
import { generatedImagePath } from '../agent-image-path';

function call(over: Partial<AgentToolCall>): AgentToolCall {
  return {
    id: 'c1',
    name: 'image',
    args: '{}',
    result: null,
    error: null,
    summary: null,
    image: null,
    ...over
  } as AgentToolCall;
}

describe('generatedImagePath', () => {
  it('takes the path from below the separator', () => {
    const result = `Drew it.\n${OUTPUT_SEPARATOR}\n/home/k/.fleet/agent/images/t/a.png\n`;
    expect(generatedImagePath(call({ result }))).toBe('/home/k/.fleet/agent/images/t/a.png');
  });

  it('reads a result with no separator as the path itself', () => {
    expect(generatedImagePath(call({ result: '/tmp/a.png' }))).toBe('/tmp/a.png');
  });

  it('has nothing to show for another tool, a failure, or an empty result', () => {
    expect(generatedImagePath(call({ name: 'read', result: '/tmp/a.png' }))).toBeNull();
    expect(generatedImagePath(call({ result: '/tmp/a.png', error: 'no' }))).toBeNull();
    expect(generatedImagePath(call({ result: `${OUTPUT_SEPARATOR}\n\n` }))).toBeNull();
    expect(generatedImagePath(call({}))).toBeNull();
  });
});

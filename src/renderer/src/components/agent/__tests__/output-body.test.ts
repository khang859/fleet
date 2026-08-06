import { describe, expect, it } from 'vitest';
import { OUTPUT_SEPARATOR, type AgentToolCall } from '../../../../../shared/agent-tools';
import { imageBody, toolBody } from '../output-body';

const call = (over: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: 'c1',
  name: 'bash',
  args: '{"command":"npm test"}',
  result: null,
  error: null,
  summary: null,
  ...over
});

describe('toolBody', () => {
  it('shows the command output and not what the tool told the model', () => {
    const result = [
      'Exit status 1 after 0.4s.',
      'The shell was the long way round here: cat → read.',
      OUTPUT_SEPARATOR,
      'one',
      'two'
    ].join('\n');

    expect(toolBody(call({ result }))).toBe('one\ntwo');
  });

  // A separator in the output is the command's own text, and the tool's is
  // always above it, so the first one is the one that counts.
  it('cuts at the separator the tool wrote, not one the command printed', () => {
    const result = [OUTPUT_SEPARATOR, 'one', OUTPUT_SEPARATOR, 'two'].join('\n');

    expect(toolBody(call({ result }))).toBe(`one\n${OUTPUT_SEPARATOR}\ntwo`);
  });

  it('shows a result with no separator whole', () => {
    expect(toolBody(call({ name: 'read', result: '1\tfirst' }))).toBe('1\tfirst');
  });

  it('shows the reason a call failed', () => {
    expect(toolBody(call({ error: 'a.ts is outside the working folder' }))).toBe(
      'a.ts is outside the working folder'
    );
  });

  it('has nothing to show for a call still running, or one that printed nothing', () => {
    expect(toolBody(call())).toBeNull();
    expect(toolBody(call({ result: `Finished in 0.1s.\n${OUTPUT_SEPARATOR}\n` }))).toBeNull();
  });
});

describe('imageBody', () => {
  const image = (over: Partial<AgentToolCall> = {}): AgentToolCall =>
    call({ name: 'image', args: '{"prompt":"a cap"}', ...over });

  it('takes the path from below the separator and serves it over fleet-image', () => {
    const result = [
      'Generated an image and saved it to /home/k/.fleet/agent/images/t/a.png (42 KB, $0.04).',
      'It is outside the working folder.',
      OUTPUT_SEPARATOR,
      '/home/k/.fleet/agent/images/t/a.png'
    ].join('\n');

    expect(imageBody(image({ result }))).toBe('fleet-image:///home/k/.fleet/agent/images/t/a.png');
  });

  it('has nothing for a call that is not an image, or failed, or is still running', () => {
    expect(imageBody(call({ result: `x\n${OUTPUT_SEPARATOR}\n/tmp/a.png` }))).toBeNull();
    expect(imageBody(image({ error: 'no credits' }))).toBeNull();
    expect(imageBody(image())).toBeNull();
  });
});

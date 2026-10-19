import { describe, expect, it } from 'vitest';
import { READ_LINE_MAX, parseExtraction } from '../agency-understanding';

const line = {
  text: 'Open PRs as drafts.',
  layer: 'project',
  source: 'your PR descriptions',
  evidence: '28 of 30 PRs were drafts.',
  clashesWith: null
};

describe('parseExtraction', () => {
  it('reads the JSON inside a fence or words', () => {
    const rest = {
      text: line.text,
      layer: line.layer,
      source: line.source,
      evidence: line.evidence
    };
    expect(
      parseExtraction(`Sure:\n\`\`\`json\n${JSON.stringify({ lines: [line] })}\n\`\`\``)
    ).toEqual([{ ...rest, clash: null }]);
  });

  it('reads the JSON after thinking, or after words with braces in them', () => {
    const json = JSON.stringify({ lines: [line] });
    expect(parseExtraction(`<think>Maybe {"lines": [] } fits?</think>\n${json}`)).toHaveLength(1);
    expect(parseExtraction(`I read the {commits} you ticked.\n${json}`)).toHaveLength(1);
  });

  it('is null for an answer that is not the JSON asked for', () => {
    expect(parseExtraction('I cannot help with that.')).toBeNull();
    expect(parseExtraction('{"lines": "none"}')).toBeNull();
    expect(parseExtraction('{"lines": [}')).toBeNull();
    // Cut off at the token limit.
    expect(parseExtraction('{"lines": [{"text": "Open PRs as dr')).toBeNull();
    expect(parseExtraction('')).toBeNull();
  });

  it('leaves out a line that does not fit, and makes the rest one line, cut to size', () => {
    const out = parseExtraction(
      JSON.stringify({
        lines: [
          { ...line, source: 'your diary' },
          { ...line, text: '   ' },
          { ...line, text: `Two\nlines ${'x'.repeat(300)}` },
          { ...line, clashesWith: { source: 'CLAUDE.md', rule: 'Ready PRs.' } }
        ]
      })
    );
    expect(out?.map((l) => l.text.length)).toEqual([READ_LINE_MAX, line.text.length]);
    expect(out?.[0].text.startsWith('Two lines')).toBe(true);
    expect(out?.[1].clash).toEqual({ source: 'CLAUDE.md', rule: 'Ready PRs.' });
  });
});

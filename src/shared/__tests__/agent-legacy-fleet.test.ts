import { describe, expect, it } from 'vitest';
import { splitFleetDigest, unfence, usedFleetTools } from '../agent-legacy-fleet';
import type { AgentMessage } from '../agent-types';

/** A digest block as the Orchestrator saved it. */
const fenced = (session: string, body: string): string =>
  `<session-data session="${session}">\n${body}\n</session-data>`;

const toolCall = (name: string): AgentMessage =>
  ({
    role: 'assistant',
    parts: [{ type: 'tool', call: { id: 'c1', name } }]
  }) as unknown as AgentMessage;

describe('splitFleetDigest', () => {
  it('takes the headlines from the first block and the rest as detail', () => {
    const headlines = [
      '- abcdef12 (fleet › api) finished its turn and is waiting for a prompt.',
      '- 99887766 (fleet › web) is waiting for the user to approve Bash.'
    ].join('\n');
    const details = `${fenced('abcdef12', 'tests pass')}\n\nLedger: #3 answered.`;

    expect(splitFleetDigest(`${fenced('all', headlines)}\n\n${details}`)).toEqual({
      headlines: [
        'abcdef12 (fleet › api) finished its turn and is waiting for a prompt.',
        '99887766 (fleet › web) is waiting for the user to approve Bash.'
      ],
      details
    });
  });

  it('has no detail for a digest that is only headlines', () => {
    expect(splitFleetDigest('- abcdef12 ended.')).toEqual({
      headlines: ['abcdef12 ended.'],
      details: ''
    });
  });
});

describe('unfence', () => {
  it('gives back the text a fence held, with its closing tag restored', () => {
    expect(unfence(fenced('abcdef12', 'done <\\/session-data> now'))).toBe(
      'done </session-data> now'
    );
  });

  it('restores the closing tag in any letter case', () => {
    expect(unfence(fenced('abcdef12', 'done <\\/SESSION-Data> now'))).toBe(
      'done </SESSION-Data> now'
    );
  });
});

describe('usedFleetTools', () => {
  it('finds a fleet tool call in the history', () => {
    expect(usedFleetTools([toolCall('read'), toolCall('fleet_read')])).toBe(true);
  });

  it('ignores a chat that called only other tools', () => {
    expect(usedFleetTools([toolCall('read')])).toBe(false);
    expect(usedFleetTools([])).toBe(false);
  });
});

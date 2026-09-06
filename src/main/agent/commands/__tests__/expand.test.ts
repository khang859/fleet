import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommandDefinition } from '../../../../shared/agent-commands';

const loadCommands = vi.fn<(cwd: string) => Promise<AgentCommandDefinition[]>>();

// The folder walk is `definitions`' to test. What matters here is what happens
// to a line once the folder has been read, so the read is stood in for.
vi.mock('../definitions', () => ({ loadCommands: async (cwd: string) => loadCommands(cwd) }));

const { expandCommand, isFusionTurn } = await import('../expand');

const REVIEW: AgentCommandDefinition = {
  name: 'pr-review',
  description: 'Review a pull request',
  template: 'Review the pull request the user named.',
  source: 'bundled',
  path: '/resources/commands/pr-review.md'
};

beforeEach(() => {
  loadCommands.mockResolvedValue([REVIEW]);
});

describe('expandCommand', () => {
  it('turns a command line into the prompt behind it', async () => {
    expect(await expandCommand('/pr-review', '/repo')).toBe(
      'Review the pull request the user named.'
    );
  });

  it('carries what the user typed after the name', async () => {
    expect(await expandCommand('/pr-review 123 look at the watcher', '/repo')).toBe(
      'Review the pull request the user named.\n\nWhat the user typed after the command: 123 look at the watcher'
    );
  });

  it('reads the folder the pane is open on', async () => {
    await expandCommand('/pr-review', '/some/repo');
    expect(loadCommands).toHaveBeenCalledWith('/some/repo');
  });

  // The load-bearing case. Main is stateless and the pane resends its whole
  // history every turn, so the same message comes back through here again and
  // again - and has to expand every time, or a review loses its instructions
  // the moment the conversation carries on.
  it('expands the same line again on a later turn', async () => {
    const first = await expandCommand('/pr-review 123', '/repo');
    const second = await expandCommand('/pr-review 123', '/repo');
    expect(second).toBe(first);
    expect(second).toContain('Review the pull request');
  });

  // A file edited between two turns takes effect on the second, the way an
  // `@`-mentioned file is re-read rather than remembered.
  it('picks up an edited prompt on the next turn', async () => {
    loadCommands.mockResolvedValue([{ ...REVIEW, template: 'Review it differently.' }]);
    expect(await expandCommand('/pr-review', '/repo')).toBe('Review it differently.');
  });

  it('leaves a message that is not a command alone', async () => {
    expect(await expandCommand('what does /pr-review do?', '/repo')).toBe(
      'what does /pr-review do?'
    );
    expect(await expandCommand('', '/repo')).toBe('');
    expect(await expandCommand('/usr/local/bin is on the path', '/repo')).toBe(
      '/usr/local/bin is on the path'
    );
  });

  // A name this folder does not have is a message, not an error. The composer
  // would not have offered it, but the user can always type one.
  it('leaves a command nobody has on disk alone', async () => {
    expect(await expandCommand('/not-a-command 1', '/repo')).toBe('/not-a-command 1');
    loadCommands.mockResolvedValue([]);
    expect(await expandCommand('/pr-review 123', '/repo')).toBe('/pr-review 123');
  });
});

/**
 * Which turns get the panel.
 *
 * The check has to be exact both ways. Too loose and a message that merely
 * mentions the word arms nine model calls; too tight and the review the user
 * asked for runs without the tool it needs.
 */
describe('isFusionTurn', () => {
  it('arms the turn the command was typed on, with or without an argument', () => {
    expect(isFusionTurn('/fusion')).toBe(true);
    expect(isFusionTurn('/fusion focus on the retry loop')).toBe(true);
    expect(isFusionTurn('  /Fusion  ')).toBe(true);
  });

  it('leaves every other turn alone', () => {
    expect(isFusionTurn('')).toBe(false);
    expect(isFusionTurn('run a fusion review of this branch')).toBe(false);
    expect(isFusionTurn('what does /fusion do?')).toBe(false);
    expect(isFusionTurn('/pr-review 123')).toBe(false);
    expect(isFusionTurn('/fusion-notes')).toBe(false);
  });
});

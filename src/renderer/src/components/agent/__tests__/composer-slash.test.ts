import { describe, expect, it } from 'vitest';
import { agentSlashCommand, agentSlashMenu } from '../composer-slash';

/**
 * The menu has to stay out of the way of ordinary typing: a message that
 * happens to contain a slash is a message, not a command, and the only thing
 * that opens the menu is an input that is nothing but a slash token.
 */

describe('agentSlashMenu', () => {
  it('opens on a bare slash and offers everything', () => {
    const menu = agentSlashMenu('/', false);

    expect(menu.open).toBe(true);
    expect(menu.matches.map((c) => c.name)).toEqual(['clear']);
  });

  it('narrows to what the user has typed so far', () => {
    expect(agentSlashMenu('/cl', false).matches.map((c) => c.name)).toEqual(['clear']);
    expect(agentSlashMenu('/clear', false).matches.map((c) => c.name)).toEqual(['clear']);
  });

  it('closes when nothing matches, rather than showing an empty box', () => {
    expect(agentSlashMenu('/zzz', false)).toEqual({ open: false, matches: [] });
  });

  it('stays shut for text that merely has a slash in it', () => {
    expect(agentSlashMenu('', false).open).toBe(false);
    expect(agentSlashMenu('what does /clear do', false).open).toBe(false);
    expect(agentSlashMenu('/clear the cache please', false).open).toBe(false);
    expect(agentSlashMenu('read src/main/index.ts', false).open).toBe(false);
    expect(agentSlashMenu('/', false).open).toBe(true);
  });

  // Whether a dismissal is still in force is the caller's to decide, not this
  // function's: it is told, and it obeys, however long the composer chooses to
  // hold it.
  it('stays shut once dismissed', () => {
    expect(agentSlashMenu('/', true).open).toBe(false);
    expect(agentSlashMenu('/cl', true).open).toBe(false);
  });
});

/**
 * A line typed in full and a row picked from the menu have to end up at the
 * same command, which is what this reads back - the composer runs whatever it
 * returns rather than testing for a name of its own.
 */
describe('agentSlashCommand', () => {
  it('reads a command written out in full', () => {
    expect(agentSlashCommand('/clear')?.name).toBe('clear');
    expect(agentSlashCommand('  /Clear  ')?.name).toBe('clear');
  });

  it('is nothing for a message that only looks like one', () => {
    expect(agentSlashCommand('/cl')).toBeUndefined();
    expect(agentSlashCommand('/clear the cache please')).toBeUndefined();
    expect(agentSlashCommand('clear')).toBeUndefined();
    expect(agentSlashCommand('')).toBeUndefined();
  });
});

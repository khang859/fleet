import { describe, expect, it } from 'vitest';
import { RESERVED_COMMAND_NAMES } from '../../../../../shared/agent-commands';
import {
  BUILTIN_SLASH_COMMANDS,
  agentSlashCommand,
  agentSlashMenu,
  isSlashQuery,
  promptCommand,
  type AgentSlashCommand
} from '../composer-slash';

/**
 * Two lists of the same names in two processes: the composer's builtins, and
 * the ones the loader refuses to let a file take. Nothing in the types ties
 * them together, so this does.
 *
 * Drifting either way is a quiet failure. A builtin that is not reserved can be
 * shadowed by a file and stop working; a name reserved with no builtin behind it
 * is a word nobody may use for nothing.
 */
describe('the builtins and the names files may not take', () => {
  it('are the same list', () => {
    const builtins = BUILTIN_SLASH_COMMANDS.map((c) => c.name).sort();
    expect(builtins).toEqual([...RESERVED_COMMAND_NAMES].sort());
  });
});

describe('isSlashQuery', () => {
  it('is true only while the whole input is one slash token', () => {
    expect(isSlashQuery('/')).toBe(true);
    expect(isSlashQuery('/pr-rev')).toBe(true);
    // A space means arguments have started, and the roster is already settled.
    expect(isSlashQuery('/pr-review 123')).toBe(false);
    expect(isSlashQuery('hello')).toBe(false);
    expect(isSlashQuery('')).toBe(false);
  });
});

/**
 * The menu has to stay out of the way of ordinary typing: a message that
 * happens to contain a slash is a message, not a command, and the only thing
 * that opens the menu is an input that is nothing but a slash token.
 */

/** A folder with one command on disk, which is the case worth testing against. */
const COMMANDS: AgentSlashCommand[] = [
  ...BUILTIN_SLASH_COMMANDS,
  promptCommand({ name: 'pr-review', description: 'Review a GitHub pull request' })
];

const names = (menu: { matches: AgentSlashCommand[] }): string[] => menu.matches.map((c) => c.name);

describe('agentSlashMenu', () => {
  it('opens on a bare slash and offers everything', () => {
    const menu = agentSlashMenu('/', COMMANDS, false);

    expect(menu.open).toBe(true);
    expect(names(menu)).toEqual(['clear', 'pr-review']);
  });

  it('narrows to what the user has typed so far', () => {
    expect(names(agentSlashMenu('/cl', COMMANDS, false))).toEqual(['clear']);
    expect(names(agentSlashMenu('/clear', COMMANDS, false))).toEqual(['clear']);
    expect(names(agentSlashMenu('/pr', COMMANDS, false))).toEqual(['pr-review']);
  });

  it('closes when nothing matches, rather than showing an empty box', () => {
    expect(agentSlashMenu('/zzz', COMMANDS, false)).toEqual({ open: false, matches: [] });
  });

  it('stays shut for text that merely has a slash in it', () => {
    expect(agentSlashMenu('', COMMANDS, false).open).toBe(false);
    expect(agentSlashMenu('what does /clear do', COMMANDS, false).open).toBe(false);
    expect(agentSlashMenu('/clear the cache please', COMMANDS, false).open).toBe(false);
    expect(agentSlashMenu('read src/main/index.ts', COMMANDS, false).open).toBe(false);
    expect(agentSlashMenu('/', COMMANDS, false).open).toBe(true);
  });

  // Once there is a space there is nothing left to narrow: the name is settled
  // and what follows is the argument, which the menu has no opinion about.
  it('closes once the user has moved on to arguments', () => {
    expect(agentSlashMenu('/pr-review ', COMMANDS, false).open).toBe(false);
    expect(agentSlashMenu('/pr-review 123', COMMANDS, false).open).toBe(false);
  });

  // Whether a dismissal is still in force is the caller's to decide, not this
  // function's: it is told, and it obeys, however long the composer chooses to
  // hold it.
  it('stays shut once dismissed', () => {
    expect(agentSlashMenu('/', COMMANDS, true).open).toBe(false);
    expect(agentSlashMenu('/cl', COMMANDS, true).open).toBe(false);
  });

  // A folder whose commands have not arrived yet still has the builtins, and
  // the menu must not go blank while it waits.
  it('offers the builtins on their own', () => {
    expect(names(agentSlashMenu('/', BUILTIN_SLASH_COMMANDS, false))).toEqual(['clear']);
  });
});

/**
 * A line typed in full and a row picked from the menu have to end up at the
 * same command, which is what this reads back - the composer runs whatever it
 * returns rather than testing for a name of its own.
 */
describe('agentSlashCommand', () => {
  it('reads a builtin written out in full', () => {
    expect(agentSlashCommand('/clear', COMMANDS)?.command.name).toBe('clear');
    expect(agentSlashCommand('  /Clear  ', COMMANDS)?.command.name).toBe('clear');
  });

  it('is nothing for a message that only looks like one', () => {
    expect(agentSlashCommand('/cl', COMMANDS)).toBeUndefined();
    expect(agentSlashCommand('clear', COMMANDS)).toBeUndefined();
    expect(agentSlashCommand('', COMMANDS)).toBeUndefined();
    expect(agentSlashCommand('what does /clear do', COMMANDS)).toBeUndefined();
  });

  // A builtin is behaviour with nothing to configure, so a line that carries
  // words after it is a sentence about the command rather than the command.
  it('will not read a builtin that has been given arguments', () => {
    expect(agentSlashCommand('/clear the cache please', COMMANDS)).toBeUndefined();
  });

  // The four forms the composer has to accept, all falling out of one parse.
  it('reads a prompt command with or without arguments', () => {
    expect(agentSlashCommand('/pr-review', COMMANDS)).toEqual({
      command: COMMANDS[1],
      args: ''
    });
    expect(agentSlashCommand('/pr-review 123', COMMANDS)?.args).toBe('123');
    expect(agentSlashCommand('/pr-review https://github.com/o/r/pull/7', COMMANDS)?.args).toBe(
      'https://github.com/o/r/pull/7'
    );
    expect(agentSlashCommand('/pr-review 123 focus on the auth changes', COMMANDS)?.args).toBe(
      '123 focus on the auth changes'
    );
  });

  // Picking it from the menu leaves a trailing space in the box, and pressing
  // Enter on that has to mean the same as never having typed it.
  it('ignores the space the menu leaves behind', () => {
    expect(agentSlashCommand('/pr-review ', COMMANDS)?.args).toBe('');
  });

  it('is nothing for a command this folder does not have', () => {
    expect(agentSlashCommand('/pr-review 123', BUILTIN_SLASH_COMMANDS)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { parseCommandLine, renderCommandPrompt } from '../agent-commands';

/**
 * Both sides of the app read a `/command` line with this, so what it says a
 * line is has to be the same answer in the composer and on the way to the
 * model. A disagreement here is either a prompt expanded that nobody asked for
 * or a bare slash and a number sent as a message.
 */
describe('parseCommandLine', () => {
  it('reads a name on its own', () => {
    expect(parseCommandLine('/pr-review')).toEqual({ name: 'pr-review', args: '' });
  });

  it('takes everything after the name as one argument', () => {
    expect(parseCommandLine('/pr-review 123 focus on the auth changes')).toEqual({
      name: 'pr-review',
      args: '123 focus on the auth changes'
    });
  });

  it('keeps a URL intact', () => {
    expect(parseCommandLine('/pr-review https://github.com/o/r/pull/7')?.args).toBe(
      'https://github.com/o/r/pull/7'
    );
  });

  // The name is what the user types to choose a file, and a file's name is
  // lowercase by the schema - so the two have to meet somewhere.
  it('lowercases the name but leaves the arguments alone', () => {
    expect(parseCommandLine('/PR-Review Focus On Auth')).toEqual({
      name: 'pr-review',
      args: 'Focus On Auth'
    });
  });

  it('ignores space around the line', () => {
    expect(parseCommandLine('   /pr-review 123   ')).toEqual({ name: 'pr-review', args: '123' });
  });

  it('is nothing for anything that is not one', () => {
    expect(parseCommandLine('')).toBeNull();
    expect(parseCommandLine('/')).toBeNull();
    expect(parseCommandLine('pr-review 123')).toBeNull();
    expect(parseCommandLine('what does /pr-review do')).toBeNull();
    // An absolute path opens with a slash and a word like a command does. What
    // tells them apart is that a name is followed by a space or by nothing, so
    // the second slash is what stops this being read as `/usr`.
    expect(parseCommandLine('/usr/local/bin')).toBeNull();
    expect(parseCommandLine('/etc/hosts is where it lives')).toBeNull();
  });

  it('reads a line that runs over several of them', () => {
    expect(parseCommandLine('/pr-review 123\nand look at the watcher')).toEqual({
      name: 'pr-review',
      args: '123\nand look at the watcher'
    });
  });
});

describe('renderCommandPrompt', () => {
  it('puts the arguments where the template asks for them', () => {
    expect(renderCommandPrompt('Review $ARGUMENTS carefully.', '123')).toBe(
      'Review 123 carefully.'
    );
  });

  it('fills in every mention, not just the first', () => {
    expect(renderCommandPrompt('$ARGUMENTS, then $ARGUMENTS again', 'x')).toBe('x, then x again');
  });

  // A template that asks for them and is given none should read as though the
  // user said nothing, rather than leaving the placeholder in the prompt.
  it('empties the placeholder when there was nothing to put in it', () => {
    expect(renderCommandPrompt('Review $ARGUMENTS.', '')).toBe('Review .');
  });

  // The case a prompt file will get wrong eventually: no placeholder at all.
  // Dropping what the user typed would be worse than putting it at the end.
  it('appends what the user typed when the template never asked', () => {
    expect(renderCommandPrompt('Review the PR.', '123')).toBe(
      'Review the PR.\n\nWhat the user typed after the command: 123'
    );
  });

  it('adds nothing when there is nothing to add', () => {
    expect(renderCommandPrompt('Review the PR.', '')).toBe('Review the PR.');
  });
});

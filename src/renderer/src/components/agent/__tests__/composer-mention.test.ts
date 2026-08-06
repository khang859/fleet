import { describe, expect, it } from 'vitest';
import { agentMentionQuery, withoutMentionQuery } from '../composer-mention';

/**
 * When the `@` menu opens, and - just as important - when it stays shut. An
 * `@` is a common character in ordinary text, so the cost of being eager here
 * is a menu that pops up over the user's sentence for no reason.
 */

describe('agentMentionQuery', () => {
  it('opens on a bare @, because "show me what is here" is the first thing typed', () => {
    expect(agentMentionQuery('@', false)).toBe('');
    expect(agentMentionQuery('look at @', false)).toBe('');
  });

  it('searches for what has been typed after it', () => {
    expect(agentMentionQuery('@read', false)).toBe('read');
    expect(agentMentionQuery('compare @src/main/agent/read.ts', false)).toBe(
      'src/main/agent/read.ts'
    );
    expect(agentMentionQuery('@my-file_v2.ts', false)).toBe('my-file_v2.ts');
  });

  // The rule the whole thing rests on: an `@` in the middle of a word belongs
  // to that word.
  it('stays shut for an @ that is part of something else', () => {
    expect(agentMentionQuery('mail me at k@example.com', false)).toBeNull();
    expect(agentMentionQuery('npm i react@18', false)).toBeNull();
    expect(agentMentionQuery('@types/node@20', false)).toBeNull();
  });

  it('stays shut once the token is behind the cursor', () => {
    expect(agentMentionQuery('@read.ts and then', false)).toBeNull();
    expect(agentMentionQuery('@read.ts ', false)).toBeNull();
  });

  it('stays shut on an empty line', () => {
    expect(agentMentionQuery('', false)).toBeNull();
  });

  // Escape closes it. Without this the menu would reopen on the next keystroke,
  // since the text it is reading has not changed.
  it('stays shut after it has been dismissed', () => {
    expect(agentMentionQuery('@read', true)).toBeNull();
  });
});

describe('withoutMentionQuery', () => {
  it('takes the token out, since the file is now a chip above the box', () => {
    expect(withoutMentionQuery('@read.ts')).toBe('');
    expect(withoutMentionQuery('compare @read')).toBe('compare ');
  });

  // The space before it was the user's, separating two words - so the sentence
  // has to still read as two words afterwards.
  it('leaves one space where the word it removed was', () => {
    expect(withoutMentionQuery('look at @src/a')).toBe('look at ');
  });

  it('leaves a line with nothing to remove alone', () => {
    expect(withoutMentionQuery('no mention here')).toBe('no mention here');
    expect(withoutMentionQuery('k@example.com')).toBe('k@example.com');
  });
});

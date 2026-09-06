import { describe, it, expect } from 'vitest';
import { displayDir, isScratchDir, isScratchTab, scratchDir } from '../scratch';

describe('isScratchDir', () => {
  it('accepts the shared root and any chat folder inside it', () => {
    expect(isScratchDir(scratchDir())).toBe(true);
    expect(isScratchDir(`${scratchDir()}/abc`)).toBe(true);
  });

  it('refuses a sibling folder whose name merely starts the same way', () => {
    expect(isScratchDir(`${scratchDir()}-old`)).toBe(false);
    expect(isScratchDir('/repo')).toBe(false);
  });
});

describe('isScratchTab', () => {
  it('is an agent tab in a scratch folder, and nothing else', () => {
    expect(isScratchTab({ type: 'agent', cwd: `${scratchDir()}/abc` })).toBe(true);
    // A terminal opened on the same folder is not the conversation.
    expect(isScratchTab({ type: 'terminal', cwd: scratchDir() })).toBe(false);
    expect(isScratchTab({ type: 'agent', cwd: '/repo' })).toBe(false);
  });
});

describe('displayDir', () => {
  // The session uuid says nothing to a reader and is long enough to squeeze the
  // tab's name out of the sidebar row.
  it('collapses a chat folder to the root it sits in', () => {
    expect(displayDir(`${scratchDir()}/92970286-df2f-44f7-bf4f-ea5e61b2ae41`)).toBe(scratchDir());
    expect(displayDir(scratchDir())).toBe(scratchDir());
  });

  it('leaves every other folder alone', () => {
    expect(displayDir('/Users/me/Development/fleet')).toBe('/Users/me/Development/fleet');
  });
});

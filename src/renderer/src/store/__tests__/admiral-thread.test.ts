import { describe, it, expect } from 'vitest';
import {
  admiralKey,
  isAdmiralKey,
  ownerPane,
  parseAdmiralKey,
  turnModeFor
} from '../admiral-thread';

describe('Admiral thread keys', () => {
  it('names the lobby and each job of a pane', () => {
    expect(admiralKey('pane-1', null)).toBe('admiral:pane-1:lobby');
    expect(admiralKey('pane-1', 12)).toBe('admiral:pane-1:j12');
  });

  it('reads a key back, even for a pane id with colons in it', () => {
    expect(parseAdmiralKey(admiralKey('a:b', 3))).toEqual({ paneId: 'a:b', jobId: 3 });
    expect(parseAdmiralKey(admiralKey('a:b', null))).toEqual({ paneId: 'a:b', jobId: null });
  });

  it.each(['pane-1', 'admiral:', 'admiral::lobby', 'admiral:p:j0', 'admiral:p:jx', 'admiral:p:7'])(
    'is not fooled by %s',
    (key) => {
      expect(parseAdmiralKey(key)).toBeNull();
      expect(isAdmiralKey(key)).toBe(false);
    }
  );

  it('maps a key to the pane that shows it', () => {
    expect(ownerPane(admiralKey('pane-1', 4))).toBe('pane-1');
    expect(ownerPane('pane-agent')).toBe('pane-agent');
  });

  it('runs an Admiral key in admiral mode whatever the orchestrator flag says', () => {
    expect(turnModeFor(admiralKey('p', null), true)).toBe('admiral');
    expect(turnModeFor(admiralKey('p', 2), false)).toBe('admiral');
    expect(turnModeFor('p', true)).toBe('orchestrator');
    expect(turnModeFor('p', false)).toBe('chat');
  });
});

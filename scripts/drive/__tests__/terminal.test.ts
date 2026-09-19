import { describe, it, expect } from 'vitest';
import { keySequence } from '../terminal';

describe('keySequence', () => {
  it('joins the named keys in order', () => {
    expect(keySequence(['ctrl-c', 'ctrl-c'])).toBe('\x03\x03');
    expect(keySequence(['down', 'enter'])).toBe('\x1b[B\r');
  });

  it('names the known keys when one is unknown', () => {
    expect(() => keySequence(['enter', 'f13'])).toThrow(/Unknown key: f13\. Known keys: enter,/);
  });
});

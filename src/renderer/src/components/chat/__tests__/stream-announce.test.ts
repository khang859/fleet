import { describe, it, expect } from 'vitest';
import { streamAnnouncement } from '../stream-announce';

describe('streamAnnouncement', () => {
  it('announces the start of generation', () => {
    expect(streamAnnouncement('idle', 'streaming', null)).toBe('Generating response…');
  });

  it('announces completion when streaming returns to idle', () => {
    expect(streamAnnouncement('streaming', 'idle', null)).toBe('Response ready');
  });

  it('announces an error with its message', () => {
    expect(streamAnnouncement('streaming', 'error', 'rate limited')).toBe('Error: rate limited');
  });

  it('announces a generic error when no message is given', () => {
    expect(streamAnnouncement('streaming', 'error', null)).toBe('Response failed');
  });

  it('says nothing on the initial idle→idle (mount)', () => {
    expect(streamAnnouncement('idle', 'idle', null)).toBeNull();
  });

  it('says nothing for a non-transition (same status)', () => {
    expect(streamAnnouncement('streaming', 'streaming', null)).toBeNull();
  });

  it('says nothing recovering from error back to idle', () => {
    expect(streamAnnouncement('error', 'idle', null)).toBeNull();
  });
});

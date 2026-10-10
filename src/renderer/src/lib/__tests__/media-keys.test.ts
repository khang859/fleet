import { describe, expect, it } from 'vitest';
import { mediaKeyCommand } from '../media-keys';

const bare = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe('mediaKeyCommand', () => {
  it('maps the player keys', () => {
    expect(mediaKeyCommand({ ...bare, key: ' ' })).toBe('toggle');
    expect(mediaKeyCommand({ ...bare, key: 'ArrowLeft' })).toBe('seek-back');
    expect(mediaKeyCommand({ ...bare, key: 'ArrowRight' })).toBe('seek-forward');
    expect(mediaKeyCommand({ ...bare, key: 'm' })).toBe('mute');
  });

  it('leaves Up and Down for the sidebar', () => {
    expect(mediaKeyCommand({ ...bare, key: 'ArrowUp' })).toBeNull();
    expect(mediaKeyCommand({ ...bare, key: 'ArrowDown' })).toBeNull();
  });

  it('leaves any key held with a modifier for the app shortcuts', () => {
    expect(mediaKeyCommand({ ...bare, key: 'ArrowLeft', metaKey: true })).toBeNull();
    expect(mediaKeyCommand({ ...bare, key: ' ', ctrlKey: true })).toBeNull();
    expect(mediaKeyCommand({ ...bare, key: 'm', altKey: true })).toBeNull();
    expect(mediaKeyCommand({ ...bare, key: 'M', shiftKey: true })).toBeNull();
  });
});

import Store from 'electron-store';
import type { Rect, SavedBounds } from './bounds';

/**
 * Where the overlay was left on each display.
 *
 * Window geometry, not a preference, so it lives beside the copilot's
 * position store rather than in the settings file.
 */
export class BoundsStore {
  private backing: Store<SavedBounds> | null = null;

  /** Opened on first use: `electron-store` writes its file when constructed. */
  private get store(): Store<SavedBounds> {
    this.backing ??= new Store<SavedBounds>({ name: 'fleet-teleprompter-bounds' });
    return this.backing;
  }

  // Fallbacks are given on every read, not as electron-store `defaults`: those
  // only fill in when the store is constructed, so a file deleted or emptied
  // while Fleet runs would read back without them.
  load(): SavedBounds {
    return {
      lastDisplayId: this.store.get('lastDisplayId', null),
      byDisplay: this.store.get('byDisplay', {})
    };
  }

  save(displayId: number, rect: Rect): void {
    this.store.set({
      lastDisplayId: displayId,
      byDisplay: { ...this.store.get('byDisplay', {}), [String(displayId)]: rect }
    });
  }
}

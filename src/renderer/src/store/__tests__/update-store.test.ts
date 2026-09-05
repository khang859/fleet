import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore } from '../update-store';

const STAGED = { version: '2.113.0', releaseNotes: '- something' };

describe('useUpdateStore', () => {
  beforeEach(() => {
    useUpdateStore.setState({ status: { state: 'idle' }, staged: null, whatsNewOpen: false });
  });

  it('mirrors the snapshot main sent', () => {
    useUpdateStore.getState().setSnapshot({
      status: { state: 'ready', ...STAGED },
      staged: STAGED
    });
    expect(useUpdateStore.getState().staged).toEqual(STAGED);
    expect(useUpdateStore.getState().status.state).toBe('ready');
  });

  /**
   * Whether a downloaded update is still installable is main's call - it is the
   * side that knows whether the updater deleted the file - so a snapshot saying
   * the staged update is gone takes it away here too, whatever the status is.
   */
  it('drops the staged update when main says it is gone', () => {
    const store = useUpdateStore.getState();
    store.setSnapshot({ status: { state: 'ready', ...STAGED }, staged: STAGED });
    store.setSnapshot({ status: { state: 'error', message: 'ENOTFOUND' }, staged: null });
    expect(useUpdateStore.getState().staged).toBeNull();
  });

  it('keeps the staged update through a status that did not invalidate it', () => {
    const store = useUpdateStore.getState();
    store.setSnapshot({ status: { state: 'ready', ...STAGED }, staged: STAGED });
    store.setSnapshot({ status: { state: 'not-available' }, staged: STAGED });
    expect(useUpdateStore.getState().staged).toEqual(STAGED);
  });

  it('dismisses a transient status without touching what is staged', () => {
    const store = useUpdateStore.getState();
    store.setSnapshot({ status: { state: 'not-available' }, staged: STAGED });
    store.dismissStatus();
    expect(useUpdateStore.getState().status.state).toBe('idle');
    expect(useUpdateStore.getState().staged).toEqual(STAGED);
  });
});

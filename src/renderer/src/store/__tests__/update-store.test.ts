import { describe, it, expect, beforeEach } from 'vitest';
import { useUpdateStore } from '../update-store';

const READY = {
  state: 'ready',
  version: '2.113.0',
  releaseNotes: '- something'
} as const;

describe('useUpdateStore', () => {
  beforeEach(() => {
    useUpdateStore.setState({ status: { state: 'idle' }, staged: null, whatsNewOpen: false });
  });

  it('stages the update a ready status carries', () => {
    useUpdateStore.getState().setStatus(READY);
    expect(useUpdateStore.getState().staged).toEqual({
      version: '2.113.0',
      releaseNotes: '- something'
    });
  });

  /**
   * The reason `staged` is not derived from `status`. A check runs every four
   * hours now, so there is always a next one; the first to fail offline would
   * otherwise take the pill, the sidebar dot and the install button with it,
   * leaving an update sitting on disk that the user has no way to install.
   */
  it('keeps the staged update through a later failed check', () => {
    const store = useUpdateStore.getState();
    store.setStatus(READY);
    store.setStatus({ state: 'checking' });
    store.setStatus({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });

    expect(useUpdateStore.getState().status.state).toBe('error');
    expect(useUpdateStore.getState().staged?.version).toBe('2.113.0');
  });

  it('keeps it through a check that finds nothing newer', () => {
    const store = useUpdateStore.getState();
    store.setStatus(READY);
    store.setStatus({ state: 'not-available' });
    expect(useUpdateStore.getState().staged?.version).toBe('2.113.0');
  });

  it('replaces it when a newer version becomes ready', () => {
    const store = useUpdateStore.getState();
    store.setStatus(READY);
    store.setStatus({ state: 'ready', version: '2.114.0', releaseNotes: '- newer' });
    expect(useUpdateStore.getState().staged).toEqual({
      version: '2.114.0',
      releaseNotes: '- newer'
    });
  });

  it('stages nothing before an update has been downloaded', () => {
    const store = useUpdateStore.getState();
    store.setStatus({ state: 'checking' });
    store.setStatus({ state: 'downloading', version: '2.113.0', releaseNotes: '', percent: 40 });
    expect(useUpdateStore.getState().staged).toBeNull();
  });
});

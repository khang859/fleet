import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRuneAssistStore } from '../rune-assist-store';
import { registerEditorHandle, unregisterEditorHandle } from '../../lib/editor-context-registry';

beforeEach(() => {
  useRuneAssistStore.setState({ panes: {} });
  // window.fleet.runeAssist is polyfilled per-test below.
});

describe('rune-assist-store', () => {
  it('opens and closes the overlay for a pane', () => {
    const { openOverlay, closeOverlay } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 10, left: 20 } });
    expect(useRuneAssistStore.getState().panes['p1']!.open).toBe(true);
    expect(useRuneAssistStore.getState().panes['p1']!.cwd).toBe('/repo');
    closeOverlay('p1');
    expect(useRuneAssistStore.getState().panes['p1']!.open).toBe(false);
  });

  it('records the draft text', () => {
    const { openOverlay, setDraft } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    setDraft('p1', 'hello');
    expect(useRuneAssistStore.getState().panes['p1']!.draft).toBe('hello');
  });

  it('applyStatus moves the pane through phases and keeps the prompt on error', () => {
    const { openOverlay, setDraft, applyStatus } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    setDraft('p1', 'do it');
    applyStatus('p1', { phase: 'working', step: 'reading…' });
    expect(useRuneAssistStore.getState().panes['p1']!.phase).toBe('working');
    expect(useRuneAssistStore.getState().panes['p1']!.step).toBe('reading…');
    applyStatus('p1', { phase: 'error', error: 'boom' });
    const p = useRuneAssistStore.getState().panes['p1']!;
    expect(p.phase).toBe('error');
    expect(p.error).toBe('boom');
    expect(p.draft).toBe('do it'); // prompt preserved for Retry
  });

  it('applyResult in ask mode stores the answer and goes idle', () => {
    const { openOverlay, applyResult } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    applyResult('p1', { cwd: '/repo', paneId: 'p1', mode: 'ask', answer: '42' });
    const p = useRuneAssistStore.getState().panes['p1']!;
    expect(p.answer).toBe('42');
    expect(p.phase).toBe('idle');
  });

  it('send is rejected locally when the pane is already working', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: { fleet: unknown } }).window = {
      fleet: { runeAssist: { send } }
    };
    const store = useRuneAssistStore.getState();
    store.openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    store.applyStatus('p1', { phase: 'working' });
    await store.send('p1', 'finish it');
    expect(send).not.toHaveBeenCalled();
  });

  it('revert writes the snapshot back through the editor handle and disarms', async () => {
    const writeContent = vi.fn().mockResolvedValue(undefined);
    registerEditorHandle('p1', {
      getSelection: () => ({ fromLine: 1, toLine: 1 }),
      getContent: () => 'current',
      reloadFromDisk: vi.fn().mockResolvedValue('current'),
      flashLines: () => {},
      writeContent
    });
    const store = useRuneAssistStore.getState();
    store.openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    useRuneAssistStore.setState((s) => ({
      panes: { ...s.panes, p1: { ...s.panes['p1']!, editSnapshot: 'original', lastEdited: true } }
    }));
    await store.revert('p1');
    expect(writeContent).toHaveBeenCalledWith('original');
    const p = useRuneAssistStore.getState().panes['p1']!;
    expect(p.lastEdited).toBe(false);
    expect(p.editSnapshot).toBeNull();
    unregisterEditorHandle('p1');
  });

  it('applyResult in edit mode goes idle and marks lastEdited', () => {
    const { openOverlay, applyResult } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    applyResult('p1', { cwd: '/repo', paneId: 'p1', mode: 'edit', changedFiles: ['a.ts'] });
    const p = useRuneAssistStore.getState().panes['p1']!;
    expect(p.phase).toBe('idle');
    expect(p.lastEdited).toBe(true);
  });

  it('send collapses the overlay so the result affordance can show', async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: { fleet: unknown } }).window = {
      fleet: { runeAssist: { send: sendSpy } }
    };
    const store = useRuneAssistStore.getState();
    store.openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    await store.send('p1', 'add a guard');
    expect(useRuneAssistStore.getState().panes['p1']!.open).toBe(false);
  });

  it('applyStatus error reopens the overlay with the message', () => {
    const { openOverlay, applyStatus } = useRuneAssistStore.getState();
    openOverlay('p1', { cwd: '/repo', contextFile: 'a.ts', anchor: { top: 0, left: 0 } });
    // simulate overlay collapsed by a prior send
    useRuneAssistStore.setState((s) => ({
      panes: { ...s.panes, p1: { ...s.panes['p1']!, open: false } }
    }));
    applyStatus('p1', { phase: 'error', error: 'boom' });
    const p = useRuneAssistStore.getState().panes['p1']!;
    expect(p.open).toBe(true);
    expect(p.error).toBe('boom');
  });
});

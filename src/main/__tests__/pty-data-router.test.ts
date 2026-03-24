import { describe, it, expect, vi } from 'vitest';
import { PtyDataRouter } from '../pty-data-router';

describe('PtyDataRouter', () => {
  it('routes data to the registered pane callback', () => {
    const router = new PtyDataRouter();
    const cb = vi.fn();
    router.register('pane-1', cb);

    router.dispatch({ paneId: 'pane-1', data: 'hello' });

    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('does not call callbacks for other panes', () => {
    const router = new PtyDataRouter();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    router.register('pane-1', cb1);
    router.register('pane-2', cb2);

    router.dispatch({ paneId: 'pane-1', data: 'hello' });

    expect(cb1).toHaveBeenCalledWith('hello');
    expect(cb2).not.toHaveBeenCalled();
  });

  it('unregisters a pane when the returned cleanup function is called', () => {
    const router = new PtyDataRouter();
    const cb = vi.fn();
    const unsubscribe = router.register('pane-1', cb);

    unsubscribe();
    router.dispatch({ paneId: 'pane-1', data: 'hello' });

    expect(cb).not.toHaveBeenCalled();
  });

  it('silently ignores data for unregistered panes', () => {
    const router = new PtyDataRouter();

    // Should not throw
    router.dispatch({ paneId: 'unknown', data: 'hello' });
  });

  it('replaces the callback when registering the same pane twice', () => {
    const router = new PtyDataRouter();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    router.register('pane-1', cb1);
    router.register('pane-1', cb2);

    router.dispatch({ paneId: 'pane-1', data: 'hello' });

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('hello');
  });

  it('handles many panes with O(1) dispatch', () => {
    const router = new PtyDataRouter();
    const callbacks = new Map<string, ReturnType<typeof vi.fn>>();

    // Register 100 panes
    for (let i = 0; i < 100; i++) {
      const cb = vi.fn();
      callbacks.set(`pane-${i}`, cb);
      router.register(`pane-${i}`, cb);
    }

    // Dispatch to pane-50
    router.dispatch({ paneId: 'pane-50', data: 'targeted' });

    // Only pane-50 should receive data
    for (const [id, cb] of callbacks) {
      if (id === 'pane-50') {
        expect(cb).toHaveBeenCalledWith('targeted');
      } else {
        expect(cb).not.toHaveBeenCalled();
      }
    }
  });
});

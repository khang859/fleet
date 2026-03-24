import type { PtyDataPayload } from '../shared/ipc-api';

type Unsubscribe = () => void;

/**
 * Routes PTY data to per-pane callbacks via a Map lookup (O(1) dispatch)
 * instead of broadcasting to all listeners (O(N)).
 */
export class PtyDataRouter {
  private listeners = new Map<string, (data: string) => void>();

  register(paneId: string, callback: (data: string) => void): Unsubscribe {
    this.listeners.set(paneId, callback);
    return () => {
      // Only delete if the current callback is still the one we registered
      if (this.listeners.get(paneId) === callback) {
        this.listeners.delete(paneId);
      }
    };
  }

  dispatch(payload: PtyDataPayload): void {
    this.listeners.get(payload.paneId)?.(payload.data);
  }
}
